/**
 * m98.cross-platform-confine.test.ts — M98: cross-platform confinement coverage.
 *
 * Tests the Linux bwrap/firejail strategy and the Windows/fallback honesty
 * without spawning any real sandbox binary. Platform binary probes are
 * controlled via the injectable `_finder` parameter on buildBwrapLauncher,
 * buildFirejailLauncher, and buildLinuxLauncher. No vi.mock needed for the
 * linux launcher tests. The audit call on fallback is intercepted via vi.mock
 * only for the fallback-honesty tests (small scope).
 *
 * PROTECTED invariants:
 *   - darwin path is UNCHANGED (still produces sandbox-exec + SBPL).
 *   - The system never claims stronger confinement than the platform delivers.
 *   - When no OS sandbox is available, the audit/summary says so honestly and
 *     still confirms the remaining layers (worktree + cred-strip + proposal-only).
 *   - Never throws unless onUnsupported:'fail'.
 *
 * What is NOT tested here:
 *   - Actually spawning bwrap or firejail (environmental).
 *   - The macOS SBPL read/write proof (covered by m52.confine.test.ts and
 *     m52.write-allow.test.ts — DO NOT DUPLICATE).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Intercept audit so we can assert on fallback messages.
vi.mock('../src/core/sandbox/audit.js', () => ({
  audit: vi.fn(),
}));

import {
  buildSandboxLauncher,
  ConfinementUnsupportedError,
} from '../src/core/sandbox/confine.js';
import {
  buildBwrapLauncher,
  buildFirejailLauncher,
  buildLinuxLauncher,
} from '../src/core/sandbox/confine-linux.js';
import { audit } from '../src/core/sandbox/audit.js';

const mockAudit = audit as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Platform override helpers
// ---------------------------------------------------------------------------

function setPlatform(p: string): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    value: p,
    writable: true,
    configurable: true,
  });
  return () => {
    if (original) Object.defineProperty(process, 'platform', original);
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Finder stubs (injected — no real PATH probes)
// ---------------------------------------------------------------------------

const bwrapOnly = (name: string): string | null =>
  name === 'bwrap' ? 'bwrap' : null;

const firejailOnly = (name: string): string | null =>
  name === 'firejail' ? 'firejail' : null;

const noneFound = (_name: string): string | null => null;

// ---------------------------------------------------------------------------
// 1. buildBwrapLauncher — launcher generation (injected finder)
// ---------------------------------------------------------------------------

describe('M98 buildBwrapLauncher — launcher generation', () => {
  it('returns null when bwrap is not on PATH', () => {
    const result = buildBwrapLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', env: { TMPDIR: '/tmp' } },
      noneFound,
    );
    expect(result).toBeNull();
  });

  it('returns a SandboxLauncher with bin=bwrap when bwrap is found', () => {
    const result = buildBwrapLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', env: { TMPDIR: '/tmp' } },
      bwrapOnly,
    );
    expect(result).not.toBeNull();
    expect(result!.bin).toBe('bwrap');
  });

  it('prefixArgs contains --ro-bind / / (root read-only)', () => {
    const result = buildBwrapLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', env: { TMPDIR: '/tmp' } },
      bwrapOnly,
    );
    const args = result!.prefixArgs;
    const roIdx = args.indexOf('--ro-bind');
    expect(roIdx).toBeGreaterThan(-1);
    expect(args[roIdx + 1]).toBe('/');
    expect(args[roIdx + 2]).toBe('/');
  });

  it('prefixArgs contains --bind <worktree> <worktree> (rw workspace)', () => {
    const wt = '/home/user/my-worktree';
    const result = buildBwrapLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: wt, env: { TMPDIR: '/tmp' } },
      bwrapOnly,
    );
    const args = result!.prefixArgs;
    const bindIdx = args.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(-1);
    expect(args[bindIdx + 1]).toBe(wt);
    expect(args[bindIdx + 2]).toBe(wt);
  });

  it('prefixArgs includes --unshare-net when networkEgress:false', () => {
    const result = buildBwrapLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', env: { TMPDIR: '/tmp' } },
      bwrapOnly,
    );
    expect(result!.prefixArgs).toContain('--unshare-net');
  });

  it('prefixArgs does NOT include --unshare-net when networkEgress:true', () => {
    const result = buildBwrapLauncher(
      { mode: 'os', networkEgress: true },
      { worktree: '/home/user/project', env: { TMPDIR: '/tmp' } },
      bwrapOnly,
    );
    expect(result!.prefixArgs).not.toContain('--unshare-net');
  });

  it('prefixArgs ends with -- (engine command separator)', () => {
    const result = buildBwrapLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', env: { TMPDIR: '/tmp' } },
      bwrapOnly,
    );
    const args = result!.prefixArgs;
    expect(args[args.length - 1]).toBe('--');
  });

  it('prefixArgs includes --die-with-parent', () => {
    const result = buildBwrapLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', env: { TMPDIR: '/tmp' } },
      bwrapOnly,
    );
    expect(result!.prefixArgs).toContain('--die-with-parent');
  });

  it('extra readAllowed paths appear as --ro-bind in bwrap args (before --)', () => {
    const extra = '/opt/vendor-data';
    const result = buildBwrapLauncher(
      { mode: 'os', networkEgress: false, readAllowed: [extra] },
      { worktree: '/home/user/project', env: { TMPDIR: '/tmp' } },
      bwrapOnly,
    );
    const args = result!.prefixArgs;
    const sentinelIdx = args.lastIndexOf('--');
    const sliceBeforeSentinel = args.slice(0, sentinelIdx);
    const lastRoBind = sliceBeforeSentinel.lastIndexOf('--ro-bind');
    expect(lastRoBind).toBeGreaterThan(-1);
    expect(args[lastRoBind + 1]).toBe(extra);
    expect(args[lastRoBind + 2]).toBe(extra);
  });
});

// ---------------------------------------------------------------------------
// 2. buildFirejailLauncher — launcher generation (injected finder)
// ---------------------------------------------------------------------------

describe('M98 buildFirejailLauncher — launcher generation', () => {
  it('returns null when firejail is not on PATH', () => {
    const result = buildFirejailLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', home: '/home/user', env: { TMPDIR: '/tmp' } },
      noneFound,
    );
    expect(result).toBeNull();
  });

  it('returns a SandboxLauncher with bin=firejail when firejail is found', () => {
    const result = buildFirejailLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', home: '/home/user', env: { TMPDIR: '/tmp' } },
      firejailOnly,
    );
    expect(result).not.toBeNull();
    expect(result!.bin).toBe('firejail');
  });

  it('prefixArgs includes --noprofile', () => {
    const result = buildFirejailLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', home: '/home/user', env: { TMPDIR: '/tmp' } },
      firejailOnly,
    );
    expect(result!.prefixArgs).toContain('--noprofile');
  });

  it('prefixArgs includes --whitelist=<worktree>', () => {
    const wt = '/home/user/my-project';
    const result = buildFirejailLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: wt, home: '/home/user', env: { TMPDIR: '/tmp' } },
      firejailOnly,
    );
    expect(result!.prefixArgs).toContain(`--whitelist=${wt}`);
  });

  it('prefixArgs includes --blacklist=<home> for cred protection', () => {
    const home = '/home/user';
    const result = buildFirejailLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', home, env: { TMPDIR: '/tmp', HOME: home } },
      firejailOnly,
    );
    expect(result!.prefixArgs).toContain(`--blacklist=${home}`);
  });

  it('prefixArgs includes --net=none when networkEgress:false', () => {
    const result = buildFirejailLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/project', home: '/home/user', env: { TMPDIR: '/tmp' } },
      firejailOnly,
    );
    expect(result!.prefixArgs).toContain('--net=none');
  });

  it('prefixArgs does NOT include --net=none when networkEgress:true', () => {
    const result = buildFirejailLauncher(
      { mode: 'os', networkEgress: true },
      { worktree: '/home/user/project', home: '/home/user', env: { TMPDIR: '/tmp' } },
      firejailOnly,
    );
    expect(result!.prefixArgs).not.toContain('--net=none');
  });
});

// ---------------------------------------------------------------------------
// 3. buildLinuxLauncher — priority dispatch (injected finder)
// ---------------------------------------------------------------------------

describe('M98 buildLinuxLauncher — priority dispatch', () => {
  it('returns { launcher, tool:"bwrap" } when bwrap is present', () => {
    const result = buildLinuxLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/proj', env: { TMPDIR: '/tmp' } },
      bwrapOnly,
    );
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('bwrap');
    expect(result!.launcher.bin).toBe('bwrap');
  });

  it('returns { launcher, tool:"firejail" } when bwrap absent, firejail present', () => {
    const result = buildLinuxLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/proj', home: '/home/user', env: { TMPDIR: '/tmp' } },
      firejailOnly,
    );
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('firejail');
    expect(result!.launcher.bin).toBe('firejail');
  });

  it('returns null when neither bwrap nor firejail are present', () => {
    const result = buildLinuxLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/proj', env: { TMPDIR: '/tmp' } },
      noneFound,
    );
    expect(result).toBeNull();
  });

  it('bwrap takes priority over firejail when both are present', () => {
    const bothPresent = (name: string): string | null =>
      name === 'bwrap' || name === 'firejail' ? name : null;
    const result = buildLinuxLauncher(
      { mode: 'os', networkEgress: false },
      { worktree: '/home/user/proj', env: { TMPDIR: '/tmp' } },
      bothPresent,
    );
    expect(result!.tool).toBe('bwrap');
  });
});

// ---------------------------------------------------------------------------
// 4. win32 — honest fallback, no false claims
// ---------------------------------------------------------------------------

describe('M98 win32 — honest fallback (no OS confinement)', () => {
  it('returns null on win32 (no first-class OS sandbox)', () => {
    const restore = setPlatform('win32');
    try {
      const launcher = buildSandboxLauncher(
        { mode: 'os', onUnsupported: 'fallback' },
        { worktree: 'C:\\Users\\user\\project' },
      );
      expect(launcher).toBeNull();
    } finally {
      restore();
    }
  });

  it('does not throw on win32 with onUnsupported:fallback', () => {
    const restore = setPlatform('win32');
    try {
      expect(() =>
        buildSandboxLauncher(
          { mode: 'os', onUnsupported: 'fallback' },
          { worktree: 'C:\\Users\\user\\project' },
        ),
      ).not.toThrow();
    } finally {
      restore();
    }
  });

  it('win32 audit summary mentions win32 and no OS sandbox (honest report)', () => {
    const restore = setPlatform('win32');
    try {
      buildSandboxLauncher(
        { mode: 'os', onUnsupported: 'fallback' },
        { worktree: 'C:\\Users\\user\\project' },
      );

      expect(mockAudit).toHaveBeenCalledOnce();
      const call = mockAudit.mock.calls[0][0] as { summary: string };
      expect(call.summary).toContain('win32');
      expect(call.summary).toContain('no OS sandbox');
    } finally {
      restore();
    }
  });

  it('win32 audit summary names remaining layers (worktree + cred-strip + proposal-only)', () => {
    const restore = setPlatform('win32');
    try {
      buildSandboxLauncher(
        { mode: 'os', onUnsupported: 'fallback' },
        { worktree: 'C:\\Users\\user\\project' },
      );

      const call = mockAudit.mock.calls[0][0] as { summary: string };
      expect(call.summary).toContain('worktree');
      expect(call.summary).toContain('cred-strip');
      expect(call.summary).toContain('proposal-only');
    } finally {
      restore();
    }
  });

  it('win32 does NOT claim confinement — summary says NOT enforced', () => {
    const restore = setPlatform('win32');
    try {
      buildSandboxLauncher(
        { mode: 'os', onUnsupported: 'fallback' },
        { worktree: 'C:\\Users\\user\\project' },
      );

      const call = mockAudit.mock.calls[0][0] as { summary: string };
      expect(call.summary).toContain('NOT enforced');
    } finally {
      restore();
    }
  });

  it('throws ConfinementUnsupportedError on win32 with onUnsupported:fail', () => {
    const restore = setPlatform('win32');
    try {
      expect(() =>
        buildSandboxLauncher(
          { mode: 'os', onUnsupported: 'fail' },
          { worktree: 'C:\\Users\\user\\project' },
        ),
      ).toThrow(ConfinementUnsupportedError);
    } finally {
      restore();
    }
  });

  it('ConfinementUnsupportedError message mentions win32', () => {
    const restore = setPlatform('win32');
    try {
      let caught: Error | undefined;
      try {
        buildSandboxLauncher(
          { mode: 'os', onUnsupported: 'fail' },
          { worktree: 'C:\\Users\\user\\project' },
        );
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('win32');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. darwin — UNCHANGED (sandbox-exec still used, SBPL profile generated)
// ---------------------------------------------------------------------------

describe('M98 darwin — sandbox-exec path unchanged', () => {
  it('returns sandbox-exec launcher on darwin', () => {
    const restore = setPlatform('darwin');
    try {
      const launcher = buildSandboxLauncher(
        { mode: 'os', networkEgress: false },
        { worktree: '/tmp/some-wt', home: '/Users/test', env: { TMPDIR: '/tmp' } },
      );
      expect(launcher).not.toBeNull();
      expect(launcher!.bin).toBe('sandbox-exec');
    } finally {
      restore();
    }
  });

  it('darwin prefixArgs are ["-p", <sbpl-profile-string>]', () => {
    const restore = setPlatform('darwin');
    try {
      const launcher = buildSandboxLauncher(
        { mode: 'os', networkEgress: false },
        { worktree: '/tmp/some-wt', home: '/Users/test', env: { TMPDIR: '/tmp' } },
      );
      expect(launcher!.prefixArgs[0]).toBe('-p');
      expect(typeof launcher!.prefixArgs[1]).toBe('string');
    } finally {
      restore();
    }
  });

  it('darwin SBPL profile contains (version 1)', () => {
    const restore = setPlatform('darwin');
    try {
      const launcher = buildSandboxLauncher(
        { mode: 'os', networkEgress: false },
        { worktree: '/tmp/some-wt', home: '/Users/test', env: { TMPDIR: '/tmp' } },
      );
      expect(launcher!.prefixArgs[1]).toContain('(version 1)');
    } finally {
      restore();
    }
  });

  it('darwin SBPL profile contains (allow default)', () => {
    const restore = setPlatform('darwin');
    try {
      const launcher = buildSandboxLauncher(
        { mode: 'os', networkEgress: false },
        { worktree: '/tmp/some-wt', home: '/Users/test', env: { TMPDIR: '/tmp' } },
      );
      expect(launcher!.prefixArgs[1]).toContain('(allow default)');
    } finally {
      restore();
    }
  });

  it('darwin never emits a fallback audit event', () => {
    const restore = setPlatform('darwin');
    try {
      buildSandboxLauncher(
        { mode: 'os', networkEgress: false },
        { worktree: '/tmp/some-wt', home: '/Users/test', env: { TMPDIR: '/tmp' } },
      );
      expect(mockAudit).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Never-throws guarantee — onUnsupported:fallback on any platform
// ---------------------------------------------------------------------------

describe('M98 never-throws — onUnsupported:fallback on any platform', () => {
  for (const platform of ['linux', 'win32', 'freebsd', 'openbsd'] as const) {
    it(`does not throw on platform=${platform} with onUnsupported:fallback`, () => {
      const restore = setPlatform(platform);
      try {
        expect(() =>
          buildSandboxLauncher(
            { mode: 'os', onUnsupported: 'fallback' },
            { worktree: '/tmp/wt', env: { TMPDIR: '/tmp', PATH: '' } },
          ),
        ).not.toThrow();
      } finally {
        restore();
      }
    });
  }
});
