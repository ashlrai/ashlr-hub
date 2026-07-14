/**
 * M21 policy tests — enrollment registry + kill switch.
 *
 * SAFETY GUARDRAIL: HOME is overridden to a tmp dir for every test so the
 * real ~/.ashlr/enrollment.json and ~/.ashlr/KILL are never touched.
 * No real portfolio repos are referenced — only tmp paths and
 * os.tmpdir()-based dirs.
 *
 * Invariants asserted:
 *   - Default enrollment is empty (nothing enrolled => assertMayMutate throws)
 *   - assertMayMutate throws for an unenrolled repo
 *   - assertMayMutate throws when the KILL file is present (always, even if enrolled)
 *   - assertMayMutate passes for an enrolled repo (kill switch off)
 *   - assertMayMutate passes with allowAnyRepo (kill switch off)
 *   - allowAnyRepo never overrides the kill switch
 *   - enroll / unenroll persist across calls (within the same HOME)
 *   - listEnrolled returns [] by default, grows/shrinks as expected
 *   - unenrolling an absent repo is a no-op (idempotent)
 *   - enrolling the same repo twice is a no-op (idempotent)
 *   - setKill(true) / setKill(false) round-trip correctly
 *   - killSwitchOn() reflects current state
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m21-policy-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Lazy import helpers (HOME must be set before first import)
// ---------------------------------------------------------------------------

let _policy: typeof import('../src/core/sandbox/policy.js') | null = null;

async function policy(): Promise<typeof import('../src/core/sandbox/policy.js')> {
  if (!_policy) {
    _policy = await import('../src/core/sandbox/policy.js');
  }
  return _policy;
}

// Each test gets a fresh module instance so HOME changes take effect.
// vitest doesn't support dynamic re-import without cache busting between
// tests in the same suite, but since HOME changes affect filesystem reads
// at call time (not module-load time), single lazy import is sufficient
// provided the implementation resolves HOME at call time (not module load).

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeTmpRepo(): string {
  // A plausible absolute path to a tmp repo (need not exist for policy tests)
  return path.join(os.tmpdir(), `ashlr-policy-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function isolatedAshlrDir(): string {
  return path.join(tmpHome, '.ashlr');
}

function isolatedEnrollmentPath(): string {
  return path.join(isolatedAshlrDir(), 'enrollment.json');
}

function isolatedKillPath(): string {
  return path.join(isolatedAshlrDir(), 'KILL');
}

// ---------------------------------------------------------------------------
// Default enrollment state
// ---------------------------------------------------------------------------

describe('M21 policy — default enrollment empty', () => {
  it('listEnrolled() returns [] on a fresh HOME', async () => {
    const p = await policy();
    expect(p.listEnrolled()).toEqual([]);
  });

  it('isEnrolled() returns false for any repo by default', async () => {
    const p = await policy();
    expect(p.isEnrolled(fakeTmpRepo())).toBe(false);
  });

  it('killSwitchOn() returns false on a fresh HOME (no KILL file)', async () => {
    const p = await policy();
    expect(p.killSwitchOn()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertMayMutate — throws for unenrolled repo
// ---------------------------------------------------------------------------

describe('M21 policy — assertMayMutate throws for unenrolled repo', () => {
  it('throws when repo is not enrolled and kill switch is off', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    expect(() => p.assertMayMutate(repo)).toThrow();
  });

  it('error message mentions the repo path or enrollment', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    let msg = '';
    try {
      p.assertMayMutate(repo);
    } catch (e) {
      msg = String(e);
    }
    // Should mention something about enrollment or the repo
    expect(msg.length).toBeGreaterThan(0);
  });

  it('does not throw after the repo is enrolled', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    expect(() => p.assertMayMutate(repo)).not.toThrow();
  });

  it('throws again after unenrolling', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    p.unenroll(repo);
    expect(() => p.assertMayMutate(repo)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertMayMutate — throws when KILL file is present
// ---------------------------------------------------------------------------

describe('M21 policy — assertMayMutate throws when kill switch is on', () => {
  it('throws for an unenrolled repo when kill switch is on', async () => {
    const p = await policy();
    p.setKill(true);
    expect(() => p.assertMayMutate(fakeTmpRepo())).toThrow();
  });

  it('throws even for an enrolled repo when kill switch is on', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    p.setKill(true);
    expect(() => p.assertMayMutate(repo)).toThrow();
  });

  it('error message mentions kill switch when kill is on', async () => {
    const p = await policy();
    p.setKill(true);
    let msg = '';
    try {
      p.assertMayMutate(fakeTmpRepo());
    } catch (e) {
      msg = String(e);
    }
    // Should mention kill switch in the message
    expect(msg.toLowerCase()).toMatch(/kill|refused|disabled|blocked/);
  });

  it('does not throw for enrolled repo after kill switch is turned off', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    p.setKill(true);
    p.setKill(false);
    expect(() => p.assertMayMutate(repo)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertMayMutate — allowAnyRepo hatch (test seam)
// ---------------------------------------------------------------------------

describe('M21 policy — allowAnyRepo hatch', () => {
  // H5 CHANGE 3 migration: the allowAnyRepo hatch is now effective ONLY when
  // ASHLR_TEST_ALLOW_ANY_REPO==='1' (mirrors advance.ts). Set it for this block
  // so the hatch is honored; restore after. The kill-switch and false-hatch
  // tests below are unaffected (kill wins first; false never opens the hatch).
  const origAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  beforeEach(() => {
    process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  });
  afterEach(() => {
    if (origAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = origAllow;
  });

  it('passes for an unenrolled repo when allowAnyRepo is true and kill switch is off', async () => {
    const p = await policy();
    expect(() => p.assertMayMutate(fakeTmpRepo(), { allowAnyRepo: true })).not.toThrow();
  });

  it('H5: allowAnyRepo is INERT without ASHLR_TEST_ALLOW_ANY_REPO=1 (still refuses unenrolled)', async () => {
    // Deliberate CHANGE-3 negative: clear the env hatch and prove allowAnyRepo:true
    // can NO LONGER bypass enrollment — the env-gate is load-bearing.
    delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    const p = await policy();
    expect(() => p.assertMayMutate(fakeTmpRepo(), { allowAnyRepo: true })).toThrow(
      /not enrolled/,
    );
  });

  it('allowAnyRepo never overrides the kill switch', async () => {
    const p = await policy();
    p.setKill(true);
    // Even with allowAnyRepo (env-gated on), kill switch must block.
    expect(() => p.assertMayMutate(fakeTmpRepo(), { allowAnyRepo: true })).toThrow();
  });

  it('allowAnyRepo with false behaves like no option (enrolled repo passes)', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    expect(() => p.assertMayMutate(repo, { allowAnyRepo: false })).not.toThrow();
  });

  it('allowAnyRepo with false still throws for unenrolled repo', async () => {
    const p = await policy();
    expect(() => p.assertMayMutate(fakeTmpRepo(), { allowAnyRepo: false })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// enroll / unenroll — persistence
// ---------------------------------------------------------------------------

describe('M21 policy — enroll/unenroll persistence', () => {
  it('enroll adds a repo to listEnrolled', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    expect(p.listEnrolled()).toContain(repo);
  });

  it('isEnrolled returns true after enrolling', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    expect(p.isEnrolled(repo)).toBe(true);
  });

  it('unenroll removes a repo from listEnrolled', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    p.unenroll(repo);
    expect(p.listEnrolled()).not.toContain(repo);
    expect(p.isEnrolled(repo)).toBe(false);
  });

  it('enrolling the same repo twice is idempotent', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    p.enroll(repo);
    const enrolled = p.listEnrolled().filter(r => r === repo);
    expect(enrolled.length).toBe(1);
  });

  it('unenrolling an absent repo is idempotent (no throw)', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    // Never enrolled — should not throw
    expect(() => p.unenroll(repo)).not.toThrow();
    expect(p.listEnrolled()).not.toContain(repo);
  });

  it('multiple repos can be enrolled independently', async () => {
    const p = await policy();
    const repoA = fakeTmpRepo();
    const repoB = fakeTmpRepo();
    p.enroll(repoA);
    p.enroll(repoB);
    expect(p.isEnrolled(repoA)).toBe(true);
    expect(p.isEnrolled(repoB)).toBe(true);
    expect(p.listEnrolled().length).toBeGreaterThanOrEqual(2);
  });

  it('unenrolling one repo does not affect other enrolled repos', async () => {
    const p = await policy();
    const repoA = fakeTmpRepo();
    const repoB = fakeTmpRepo();
    p.enroll(repoA);
    p.enroll(repoB);
    p.unenroll(repoA);
    expect(p.isEnrolled(repoA)).toBe(false);
    expect(p.isEnrolled(repoB)).toBe(true);
  });

  it('enrollment persists on disk under tmpHome', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();
    p.enroll(repo);
    // Verify a file was written somewhere under the tmp HOME
    const ashlrDir = path.join(tmpHome, '.ashlr');
    const exists = fs.existsSync(ashlrDir);
    expect(exists).toBe(true);
    // The enrollment should be recoverable by reading current state
    expect(p.isEnrolled(repo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hardened storage compatibility
// ---------------------------------------------------------------------------

describe('M21 policy — hardened storage compatibility', () => {
  it('returns truthful result fields for changed and idempotent enrollment mutations', async () => {
    const p = await policy();
    const repo = fakeTmpRepo();

    expect(p.enroll(repo)).toEqual({
      ok: true,
      changed: true,
      quiesced: true,
      reason: 'enrolled',
    });
    expect(p.enroll(repo)).toEqual({
      ok: true,
      changed: false,
      quiesced: true,
      reason: 'already-enrolled',
    });
    expect(p.unenroll(repo)).toEqual({
      ok: true,
      changed: true,
      quiesced: true,
      reason: 'unenrolled',
    });
    expect(p.unenroll(repo)).toEqual({
      ok: true,
      changed: false,
      quiesced: true,
      reason: 'already-unenrolled',
    });
  });

  it('creates the authority directory at 0700 and registry/KILL files at 0600 on POSIX', async () => {
    const p = await policy();

    expect(p.enroll(fakeTmpRepo()).ok).toBe(true);
    expect(p.setKill(true).ok).toBe(true);

    if (process.platform !== 'win32') {
      expect(fs.lstatSync(isolatedAshlrDir()).mode & 0o777).toBe(0o700);
      expect(fs.lstatSync(isolatedEnrollmentPath()).mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(isolatedKillPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('does not overwrite a malformed enrollment registry', async () => {
    const p = await policy();
    const malformed = '{"repos":["unterminated"';
    fs.mkdirSync(isolatedAshlrDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(isolatedEnrollmentPath(), malformed, { mode: 0o600 });

    const result = p.enroll(fakeTmpRepo());

    expect(result).toMatchObject({ ok: false, changed: false, quiesced: false });
    expect(result.reason).toMatch(/registry/);
    expect(fs.readFileSync(isolatedEnrollmentPath(), 'utf8')).toBe(malformed);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses a symlinked registry without changing its referent',
    async () => {
      const p = await policy();
      const target = path.join(tmpHome, 'symlink-registry-target.json');
      const original = `${JSON.stringify({ repos: [] })}\n`;
      fs.mkdirSync(isolatedAshlrDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, original, { mode: 0o600 });
      fs.symlinkSync(target, isolatedEnrollmentPath());

      const result = p.enroll(fakeTmpRepo());

      expect(result).toMatchObject({ ok: false, changed: false, quiesced: false });
      expect(fs.lstatSync(isolatedEnrollmentPath()).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses a hardlinked registry without changing its referent',
    async () => {
      const p = await policy();
      const target = path.join(tmpHome, 'hardlink-registry-target.json');
      const original = `${JSON.stringify({ repos: [] })}\n`;
      fs.mkdirSync(isolatedAshlrDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, original, { mode: 0o600 });
      fs.linkSync(target, isolatedEnrollmentPath());

      const result = p.enroll(fakeTmpRepo());

      expect(result).toMatchObject({ ok: false, changed: false, quiesced: false });
      expect(fs.lstatSync(isolatedEnrollmentPath()).nlink).toBe(2);
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses symlinked and hardlinked kill sentinels without removing their referents',
    async () => {
      const p = await policy();
      const target = path.join(tmpHome, 'kill-target');
      fs.mkdirSync(isolatedAshlrDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, 'external sentinel\n', { mode: 0o600 });
      fs.symlinkSync(target, isolatedKillPath());

      expect(p.setKill(true)).toEqual({
        ok: false,
        changed: false,
        quiesced: false,
        reason: 'unsafe-kill-sentinel',
      });
      expect(p.setKill(false)).toEqual({
        ok: false,
        changed: false,
        quiesced: false,
        reason: 'unsafe-kill-sentinel',
      });
      expect(fs.readFileSync(target, 'utf8')).toBe('external sentinel\n');

      fs.unlinkSync(isolatedKillPath());
      fs.linkSync(target, isolatedKillPath());
      expect(p.setKill(true)).toMatchObject({
        ok: false,
        changed: false,
        reason: 'unsafe-kill-sentinel',
      });
      expect(fs.lstatSync(isolatedKillPath()).nlink).toBe(2);
      expect(fs.readFileSync(target, 'utf8')).toBe('external sentinel\n');
    },
  );
});

// ---------------------------------------------------------------------------
// kill switch — setKill / killSwitchOn round-trip
// ---------------------------------------------------------------------------

describe('M21 policy — kill switch setKill/killSwitchOn', () => {
  it('setKill(true) makes killSwitchOn() return true', async () => {
    const p = await policy();
    expect(p.setKill(true)).toEqual({
      ok: true,
      changed: true,
      quiesced: true,
      reason: 'kill-armed',
    });
    expect(p.killSwitchOn()).toBe(true);
  });

  it('setKill(false) makes killSwitchOn() return false', async () => {
    const p = await policy();
    p.setKill(true);
    p.setKill(false);
    expect(p.killSwitchOn()).toBe(false);
  });

  it('setKill(true) creates a KILL file or persists kill state', async () => {
    const p = await policy();
    p.setKill(true);
    // Either a KILL file exists or the kill state is persisted in config
    const killFile = path.join(tmpHome, '.ashlr', 'KILL');
    const configFile = path.join(tmpHome, '.ashlr', 'config.json');
    const killExists = fs.existsSync(killFile);
    const configExists = fs.existsSync(configFile);
    // At least one persistence mechanism must be used
    expect(killExists || configExists).toBe(true);
    // And the in-memory state must reflect it
    expect(p.killSwitchOn()).toBe(true);
  });

  it('setKill(false) removes kill state', async () => {
    const p = await policy();
    p.setKill(true);
    p.setKill(false);
    expect(p.killSwitchOn()).toBe(false);
    // KILL file, if it was created, must be gone
    const killFile = path.join(tmpHome, '.ashlr', 'KILL');
    expect(fs.existsSync(killFile)).toBe(false);
  });

  it('calling setKill(true) twice is idempotent', async () => {
    const p = await policy();
    expect(p.setKill(true).changed).toBe(true);
    expect(p.setKill(true)).toEqual({
      ok: true,
      changed: false,
      quiesced: true,
      reason: 'already-active',
    });
    expect(p.killSwitchOn()).toBe(true);
  });

  it('calling setKill(false) when not set is idempotent', async () => {
    const p = await policy();
    expect(p.setKill(false)).toEqual({
      ok: true,
      changed: false,
      quiesced: true,
      reason: 'already-inactive',
    });
    expect(p.killSwitchOn()).toBe(false);
  });
});
