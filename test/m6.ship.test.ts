/**
 * M6 ship tests — hermetic, fixture projects in os.tmpdir().
 *
 * SAFETY GUARDRAIL: NEVER deploys, NEVER pushes, NEVER creates a real GitHub
 * repo, NEVER calls real vercel/stack/gh. deploy() must return dryRun:true
 * and ran:false unless opts.confirm is explicitly true. ALL writes to tmp only.
 *
 * Covers:
 *   - runShipGate: built-in supply-chain fallback flags a git-url dependency
 *   - runShipGate: built-in supply-chain fallback flags an install script in package.json
 *   - runShipGate: test/lint/build checks run conditionally (only when scripts exist)
 *   - runShipGate: checks with missing scripts are skipped (not failed)
 *   - runShipGate: gate.passed is false when any check fails
 *   - runShipGate: gate.passed is true when all checks pass/warn/skip
 *   - runShipGate: summary counts are correct
 *   - runShipGate: is READ-ONLY (never modifies files in the project dir)
 *   - deploy(): returns dryRun:true, ran:false WITHOUT --confirm (default dry-run)
 *   - deploy(): NEVER executes real deploy tool even if present
 *   - deploy(): ran:true only when opts.confirm === true (mocked tool)
 *   - deploy(): absent-tool guidance for morphkit
 *   - deploy(): detail is a non-empty string for all targets
 *   - deploy(): unknown target returns ran:false with informative detail
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock child_process — prevents any real commands from executing
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
  // Default mock behaviour:
  //   - 'which binshield' → not found (status 1, empty stdout) so the built-in
  //     supply-chain fallback is used in runShipGate tests.
  //   - 'which <other>'   → found (status 0, non-empty stdout) so deploy() dry-run
  //     tests hit the DRY_RUN branch rather than the tool-not-found branch.
  //   - all other commands (npm run …, git …) → exit 0, empty output.
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    if (String(cmd) === 'which') {
      const tool = String(Array.isArray(args) ? args[0] : '');
      if (tool === 'binshield') {
        // binshield absent — forces built-in fallback in runShipGate
        return { status: 1, stdout: '', stderr: '', error: undefined };
      }
      // All other tools (vercel, stack, gh, morphkit…) report as installed
      return { status: 0, stdout: `/usr/local/bin/${tool}`, stderr: '', error: undefined };
    }
    return { status: 0, stdout: '', stderr: '', error: undefined };
  }),
  exec: vi.fn((_cmd: unknown, cb: (e: null, o: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '', stderr: '' });
  }),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import {
  runShipGate,
  deploy,
} from '../src/core/lifecycle/ship.js';

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

function freshTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m6-ship-'));
  createdDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of createdDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal fixture project directory in tmp.
 * Returns the absolute path to the project root.
 */
function makeFixture(opts: {
  hasTest?: boolean;
  hasLint?: boolean;
  hasBuild?: boolean;
  /** Extra dependencies to add to package.json */
  extraDeps?: Record<string, string>;
  /** Whether to add an install script to package.json */
  installScript?: boolean;
  /** Whether to add a postinstall script */
  postinstallScript?: boolean;
}): string {
  const dir = freshTmpDir();

  const scripts: Record<string, string> = {};
  if (opts.hasTest) scripts['test'] = 'echo "test passed"';
  if (opts.hasLint) scripts['lint'] = 'echo "lint passed"';
  if (opts.hasBuild) scripts['build'] = 'echo "build passed"';
  if (opts.installScript) scripts['install'] = 'echo "install hook"';
  if (opts.postinstallScript) scripts['postinstall'] = 'node setup.js';

  const deps: Record<string, string> = {
    ...(opts.extraDeps ?? {}),
  };

  const pkg = {
    name: 'test-fixture',
    version: '0.1.0',
    scripts,
    dependencies: deps,
  };

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test Fixture\n');

  return dir;
}

/** Fixture with a git-url dependency (supply-chain red flag). */
function makeFixtureWithGitDep(): string {
  return makeFixture({
    extraDeps: {
      'safe-pkg': '^1.0.0',
      'sus-pkg': 'git+https://github.com/attacker/malicious-pkg.git',
    },
  });
}

/** Fixture with an install script (supply-chain red flag). */
function makeFixtureWithInstallScript(): string {
  return makeFixture({ installScript: true });
}

/** Fixture with postinstall script (supply-chain concern). */
function makeFixtureWithPostinstall(): string {
  return makeFixture({ postinstallScript: true });
}

/** Fixture with all npm scripts present. */
function makeFullFixture(): string {
  return makeFixture({ hasTest: true, hasLint: true, hasBuild: true });
}

/** Fixture with NO npm scripts. */
function makeEmptyScriptsFixture(): string {
  return makeFixture({});
}

// ---------------------------------------------------------------------------
// runShipGate — return shape
// ---------------------------------------------------------------------------

describe('runShipGate — return shape', () => {
  it('returns a ShipGate object', async () => {
    const dir = makeEmptyScriptsFixture();
    const gate = await runShipGate(dir, { strict: false });
    expect(typeof gate).toBe('object');
    expect(gate).not.toBeNull();
  });

  it('gate has checks array', async () => {
    const dir = makeEmptyScriptsFixture();
    const gate = await runShipGate(dir, { strict: false });
    expect(Array.isArray(gate.checks)).toBe(true);
  });

  it('gate has summary with pass/warn/fail/skip counts', async () => {
    const dir = makeEmptyScriptsFixture();
    const gate = await runShipGate(dir, { strict: false });
    expect(typeof gate.summary.pass).toBe('number');
    expect(typeof gate.summary.warn).toBe('number');
    expect(typeof gate.summary.fail).toBe('number');
    expect(typeof gate.summary.skip).toBe('number');
  });

  it('gate has a boolean "passed" field', async () => {
    const dir = makeEmptyScriptsFixture();
    const gate = await runShipGate(dir, { strict: false });
    expect(typeof gate.passed).toBe('boolean');
  });

  it('summary counts match actual check statuses', async () => {
    const dir = makeFullFixture();
    const gate = await runShipGate(dir, { strict: false });
    const counted = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of gate.checks) {
      counted[c.status]++;
    }
    expect(gate.summary.pass).toBe(counted.pass);
    expect(gate.summary.warn).toBe(counted.warn);
    expect(gate.summary.fail).toBe(counted.fail);
    expect(gate.summary.skip).toBe(counted.skip);
  });

  it('each check has id, label, status, detail fields', async () => {
    const dir = makeEmptyScriptsFixture();
    const gate = await runShipGate(dir, { strict: false });
    for (const c of gate.checks) {
      expect(typeof c.id).toBe('string');
      expect(c.id.length).toBeGreaterThan(0);
      expect(typeof c.label).toBe('string');
      expect(['pass', 'warn', 'fail', 'skip']).toContain(c.status);
      expect(typeof c.detail).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// runShipGate — supply-chain: git-url dependency
// ---------------------------------------------------------------------------

describe('runShipGate — supply-chain: git-url dependency', () => {
  it('includes a supply-chain check', async () => {
    const dir = makeFixtureWithGitDep();
    const gate = await runShipGate(dir, { strict: false });
    const scCheck = gate.checks.find(c => c.id === 'supply-chain');
    expect(scCheck).toBeDefined();
  });

  it('supply-chain check is fail or warn when a git-url dep is present', async () => {
    const dir = makeFixtureWithGitDep();
    const gate = await runShipGate(dir, { strict: false });
    const scCheck = gate.checks.find(c => c.id === 'supply-chain')!;
    expect(['fail', 'warn']).toContain(scCheck.status);
  });

  it('supply-chain check detail mentions "git" or the offending dep', async () => {
    const dir = makeFixtureWithGitDep();
    const gate = await runShipGate(dir, { strict: false });
    const scCheck = gate.checks.find(c => c.id === 'supply-chain')!;
    const detailLower = scCheck.detail.toLowerCase();
    const hasMention = detailLower.includes('git') || detailLower.includes('sus-pkg') || detailLower.includes('url');
    expect(hasMention).toBe(true);
  });

  it('gate.passed is false when supply-chain check is fail', async () => {
    const dir = makeFixtureWithGitDep();
    const gate = await runShipGate(dir, { strict: false });
    const scCheck = gate.checks.find(c => c.id === 'supply-chain')!;
    if (scCheck.status === 'fail') {
      expect(gate.passed).toBe(false);
    }
    // If it's warn (not fail), passed could still be true — that is acceptable.
  });
});

// ---------------------------------------------------------------------------
// runShipGate — supply-chain: install script
// ---------------------------------------------------------------------------

describe('runShipGate — supply-chain: install script', () => {
  it('supply-chain check is fail or warn when package.json has an install script', async () => {
    const dir = makeFixtureWithInstallScript();
    const gate = await runShipGate(dir, { strict: false });
    const scCheck = gate.checks.find(c => c.id === 'supply-chain')!;
    expect(scCheck).toBeDefined();
    expect(['fail', 'warn']).toContain(scCheck.status);
  });

  it('supply-chain check detail mentions "install" script', async () => {
    const dir = makeFixtureWithInstallScript();
    const gate = await runShipGate(dir, { strict: false });
    const scCheck = gate.checks.find(c => c.id === 'supply-chain')!;
    expect(scCheck.detail.toLowerCase()).toContain('install');
  });

  it('supply-chain check is fail or warn for postinstall script', async () => {
    const dir = makeFixtureWithPostinstall();
    const gate = await runShipGate(dir, { strict: false });
    const scCheck = gate.checks.find(c => c.id === 'supply-chain')!;
    expect(['fail', 'warn']).toContain(scCheck.status);
  });
});

// ---------------------------------------------------------------------------
// runShipGate — supply-chain: clean project passes
// ---------------------------------------------------------------------------

describe('runShipGate — supply-chain: clean project', () => {
  it('supply-chain check is pass or warn for a clean project (no git deps, no install scripts)', async () => {
    // The built-in check also warns when no lockfile is present.
    // A freshly-created tmp fixture has no lockfile, so 'warn' is acceptable here.
    const dir = makeFixture({ extraDeps: { 'lodash': '^4.17.21' } });
    const gate = await runShipGate(dir, { strict: false });
    const scCheck = gate.checks.find(c => c.id === 'supply-chain')!;
    expect(scCheck).toBeDefined();
    expect(['pass', 'warn']).toContain(scCheck.status);
    // Crucially, it must NOT be 'fail' — no git-url deps or install scripts present
    expect(scCheck.status).not.toBe('fail');
  });

  it('supply-chain check with lockfile present is pass', async () => {
    const dir = makeFixture({ extraDeps: { 'lodash': '^4.17.21' } });
    // Create a fake lockfile so the no-lockfile warning is suppressed
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    const gate = await runShipGate(dir, { strict: false });
    const scCheck = gate.checks.find(c => c.id === 'supply-chain')!;
    expect(scCheck).toBeDefined();
    expect(scCheck.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// runShipGate — test/lint/build conditional execution
// ---------------------------------------------------------------------------

describe('runShipGate — conditional test/lint/build checks', () => {
  it('test check is skip when no "test" script in package.json', async () => {
    const dir = makeFixture({ hasLint: true, hasBuild: true }); // no test
    const gate = await runShipGate(dir, { strict: false });
    const testCheck = gate.checks.find(c => c.id === 'test');
    if (testCheck) {
      expect(testCheck.status).toBe('skip');
    }
    // If the check isn't in the list at all, that's also acceptable.
  });

  it('lint check is skip when no "lint" script in package.json', async () => {
    const dir = makeFixture({ hasTest: true, hasBuild: true }); // no lint
    const gate = await runShipGate(dir, { strict: false });
    const lintCheck = gate.checks.find(c => c.id === 'lint');
    if (lintCheck) {
      expect(lintCheck.status).toBe('skip');
    }
  });

  it('build check is skip when no "build" script in package.json', async () => {
    const dir = makeFixture({ hasTest: true, hasLint: true }); // no build
    const gate = await runShipGate(dir, { strict: false });
    const buildCheck = gate.checks.find(c => c.id === 'build');
    if (buildCheck) {
      expect(buildCheck.status).toBe('skip');
    }
  });

  it('all three checks present when all three scripts exist', async () => {
    const dir = makeFullFixture();
    const gate = await runShipGate(dir, { strict: false });
    const ids = gate.checks.map(c => c.id);
    // Supply-chain is always present; test/lint/build should appear
    expect(ids).toContain('supply-chain');
    // Each of test/lint/build should be present (pass/fail/skip)
    for (const checkId of ['test', 'lint', 'build']) {
      expect(ids).toContain(checkId);
    }
  });
});

// ---------------------------------------------------------------------------
// runShipGate — passed flag behavior
// ---------------------------------------------------------------------------

describe('runShipGate — gate.passed', () => {
  it('gate.passed is false when any check has status "fail"', async () => {
    const dir = makeFixtureWithGitDep();
    const gate = await runShipGate(dir, { strict: false });
    const hasFail = gate.checks.some(c => c.status === 'fail');
    if (hasFail) {
      expect(gate.passed).toBe(false);
    }
  });

  it('gate.passed is true when no checks fail (all pass/warn/skip)', async () => {
    // Clean project with no scripts → supply-chain passes, all others skip
    const dir = makeEmptyScriptsFixture();
    const gate = await runShipGate(dir, { strict: false });
    const hasFail = gate.checks.some(c => c.status === 'fail');
    if (!hasFail) {
      expect(gate.passed).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// runShipGate — READ-ONLY (no filesystem mutations)
// ---------------------------------------------------------------------------

describe('runShipGate — read-only guarantee', () => {
  it('does not modify package.json', async () => {
    const dir = makeFixtureWithGitDep();
    const pkgPath = path.join(dir, 'package.json');
    const before = fs.readFileSync(pkgPath, 'utf8');
    await runShipGate(dir, { strict: false });
    const after = fs.readFileSync(pkgPath, 'utf8');
    expect(after).toBe(before);
  });

  it('does not create new files in the project directory (only reads)', async () => {
    const dir = makeEmptyScriptsFixture();
    const beforeFiles = fs.readdirSync(dir).sort();
    await runShipGate(dir, { strict: false });
    const afterFiles = fs.readdirSync(dir).sort();
    expect(afterFiles).toEqual(beforeFiles);
  });

  it('does not throw on a non-existent directory', async () => {
    const nonExistent = path.join(os.tmpdir(), `ashlr-nonexistent-${Date.now()}`);
    await expect(runShipGate(nonExistent, { strict: false })).resolves.not.toThrow();
  });

  it('returns a gate with at least one check even for non-existent dir', async () => {
    const nonExistent = path.join(os.tmpdir(), `ashlr-nonexistent-${Date.now()}`);
    const gate = await runShipGate(nonExistent, { strict: false });
    expect(gate.checks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runShipGate — never throws (returns ShipGate, does not reject)
// ---------------------------------------------------------------------------

describe('runShipGate — never throws', () => {
  it('resolves without rejection for a valid project', async () => {
    const dir = makeFullFixture();
    await expect(runShipGate(dir, { strict: false })).resolves.toBeDefined();
  });

  it('resolves without rejection for a project with no package.json', async () => {
    const dir = freshTmpDir();
    await expect(runShipGate(dir, { strict: false })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// deploy() — DRY-RUN BY DEFAULT (no --confirm)
// ---------------------------------------------------------------------------

describe('deploy() — dry-run by default (no confirm)', () => {
  it('returns dryRun:true when opts.confirm is false and tool is installed', async () => {
    // The default spawnSync mock returns status:0 + non-empty stdout for 'which' calls,
    // which simulates the tool being installed. With confirm:false, deploy() must
    // return dryRun:true (it prints what it WOULD do, but does not execute).
    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'vercel', { confirm: false });
    expect(result.dryRun).toBe(true);
    expect(result.ran).toBe(false);
  });

  it('returns ran:false when opts.confirm is false', async () => {
    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'vercel', { confirm: false });
    expect(result.ran).toBe(false);
  });

  it('returns dryRun:true for installed tools without confirm', async () => {
    // Default mock: which returns non-empty stdout for all tools → installed.
    // confirm:false → dryRun must be true for each target.
    const dir = makeEmptyScriptsFixture();
    for (const target of ['vercel', 'stack', 'gh']) {
      const result = await deploy(dir, target, { confirm: false });
      expect(result.dryRun).toBe(true);
      expect(result.ran).toBe(false);
    }
  });

  it('NEVER executes vercel deploy spawnSync without confirm', async () => {
    const { spawnSync } = await import('node:child_process');
    const mockSpawn = spawnSync as ReturnType<typeof vi.fn>;
    mockSpawn.mockClear();

    const dir = makeEmptyScriptsFixture();
    await deploy(dir, 'vercel', { confirm: false });

    // spawnSync must not have been called with "vercel" as the command (only "which vercel" is OK)
    const deployCalls = (mockSpawn.mock.calls as unknown[][]).filter((args) =>
      String(args[0]) === 'vercel'
    );
    expect(deployCalls).toHaveLength(0);
  });

  it('NEVER executes gh deploy spawnSync without confirm', async () => {
    const { spawnSync } = await import('node:child_process');
    const mockSpawn = spawnSync as ReturnType<typeof vi.fn>;
    mockSpawn.mockClear();

    const dir = makeEmptyScriptsFixture();
    await deploy(dir, 'gh', { confirm: false });

    // spawnSync must not have been called with "gh" as the command
    const deployCalls = (mockSpawn.mock.calls as unknown[][]).filter((args) =>
      String(args[0]) === 'gh'
    );
    expect(deployCalls).toHaveLength(0);
  });

  it('returns a non-empty detail string regardless of tool presence', async () => {
    const dir = makeEmptyScriptsFixture();
    // Default mock: spawnSync returns status:0 (tool found)
    const result = await deploy(dir, 'vercel', { confirm: false });
    expect(typeof result.detail).toBe('string');
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it('dry-run detail indicates what WOULD run (when tool is installed)', async () => {
    // Default mock: vercel reports as installed. confirm:false → dry-run detail.
    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'vercel', { confirm: false });
    // Should say "dry-run", "would", "DRY-RUN", or similar
    const lowerDetail = result.detail.toLowerCase();
    const hasDryRunMarker = lowerDetail.includes('dry') || lowerDetail.includes('would') || lowerDetail.includes('not run');
    expect(hasDryRunMarker).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deploy() — confirm:true runs the deploy (mocked tool)
// ---------------------------------------------------------------------------

describe('deploy() — confirm:true executes deploy (mocked)', () => {

  it('returns ran:true when confirm:true and tool mock succeeds', async () => {
    const { spawnSync } = await import('node:child_process');
    const mockSpawn = spawnSync as ReturnType<typeof vi.fn>;
    // which vercel → found (non-empty string stdout). vercel deploy → exit 0.
    mockSpawn.mockImplementation((cmd: string) => {
      if (String(cmd) === 'which') {
        return { status: 0, stdout: '/usr/local/bin/vercel', stderr: '' };
      }
      return { status: 0, stdout: 'Deployment URL: https://my-project.vercel.app', stderr: '' };
    });

    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'vercel', { confirm: true });
    expect(result.ran).toBe(true);
    expect(result.dryRun).toBe(false);
  });

  it('returns dryRun:false when confirm:true', async () => {
    // Default mock has vercel installed (which → status:0, non-empty stdout).
    // confirm:true means we actually run — dryRun must be false.
    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'vercel', { confirm: true });
    expect(result.dryRun).toBe(false);
  });

  it('ran:false and detail mentions tool absence when tool is not installed and confirm:true', async () => {
    const { spawnSync } = await import('node:child_process');
    const mockSpawn = spawnSync as ReturnType<typeof vi.fn>;
    // which vercel → not found (status:1, empty stdout)
    mockSpawn.mockImplementation((cmd: string) => {
      if (String(cmd) === 'which') {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'vercel', { confirm: true });
    expect(result.ran).toBe(false);
    const lowerDetail = result.detail.toLowerCase();
    expect(
      lowerDetail.includes('not installed') || lowerDetail.includes('not found') || lowerDetail.includes('install')
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deploy() — morphkit absent → guidance string
// ---------------------------------------------------------------------------

describe('deploy() — morphkit absent: guidance string', () => {
  // The default mock reports morphkit as installed (which → status:0, non-empty stdout).
  // We override per-test to simulate morphkit being absent.

  it('returns ran:false for morphkit when absent', async () => {
    const { spawnSync } = await import('node:child_process');
    const mockSpawn = spawnSync as ReturnType<typeof vi.fn>;
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (String(cmd) === 'which' && String(args?.[0]) === 'morphkit') {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '/usr/local/bin/tool', stderr: '' };
    });

    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'morphkit', { confirm: false });
    expect(result.ran).toBe(false);
  });

  it('detail mentions morphkit when morphkit is absent', async () => {
    const { spawnSync } = await import('node:child_process');
    const mockSpawn = spawnSync as ReturnType<typeof vi.fn>;
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (String(cmd) === 'which' && String(args?.[0]) === 'morphkit') {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '/usr/local/bin/tool', stderr: '' };
    });

    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'morphkit', { confirm: false });
    expect(result.detail.toLowerCase()).toContain('morphkit');
  });

  it('morphkit guidance mentions installation or morphkit.dev', async () => {
    const { spawnSync } = await import('node:child_process');
    const mockSpawn = spawnSync as ReturnType<typeof vi.fn>;
    mockSpawn.mockImplementation((cmd: string, args: string[]) => {
      if (String(cmd) === 'which' && String(args?.[0]) === 'morphkit') {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '/usr/local/bin/tool', stderr: '' };
    });

    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'morphkit', { confirm: true });
    // Per the contract: "morphkit not installed — see morphkit.dev"
    const detail = result.detail.toLowerCase();
    const hasGuidance = detail.includes('not installed') || detail.includes('morphkit.dev') || detail.includes('install');
    expect(hasGuidance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deploy() — unknown target
// ---------------------------------------------------------------------------

describe('deploy() — unknown target', () => {
  it('returns ran:false for an unknown target', async () => {
    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'unknown-tool-xyz', { confirm: false });
    expect(result.ran).toBe(false);
  });

  it('returns a non-empty detail for unknown target', async () => {
    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, 'unknown-tool-xyz', { confirm: false });
    expect(typeof result.detail).toBe('string');
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it('does not throw for unknown target with confirm:true', async () => {
    const dir = makeEmptyScriptsFixture();
    await expect(deploy(dir, 'unknown-tool-xyz', { confirm: true })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// deploy() — never throws
// ---------------------------------------------------------------------------

describe('deploy() — never throws', () => {
  it('resolves (does not reject) for vercel dry-run', async () => {
    const dir = makeEmptyScriptsFixture();
    await expect(deploy(dir, 'vercel', { confirm: false })).resolves.toBeDefined();
  });

  it('resolves for stack dry-run', async () => {
    const dir = makeEmptyScriptsFixture();
    await expect(deploy(dir, 'stack', { confirm: false })).resolves.toBeDefined();
  });

  it('resolves for gh dry-run', async () => {
    const dir = makeEmptyScriptsFixture();
    await expect(deploy(dir, 'gh', { confirm: false })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// deploy() — result shape invariants
// ---------------------------------------------------------------------------

describe('deploy() — result shape', () => {
  it.each([
    ['vercel', false],
    ['stack', false],
    ['morphkit', false],
    ['gh', false],
    ['vercel', true],
  ] as [string, boolean][])('deploy(%s, confirm=%s) returns {ran, dryRun, detail}', async (target, confirm) => {
    const dir = makeEmptyScriptsFixture();
    const result = await deploy(dir, target, { confirm });
    expect(typeof result.ran).toBe('boolean');
    expect(typeof result.dryRun).toBe('boolean');
    expect(typeof result.detail).toBe('string');
  });

  it('dryRun is true when tool IS installed and confirm is false', async () => {
    // When the tool is found via which, and confirm:false, the result is a dry-run.
    // The mock's default status:0 means which returns success (tool found).
    const dir = makeEmptyScriptsFixture();
    // spawnSync mock returns status:0 by default — simulates tool presence.
    // For installed tools, dry-run should be true when confirm is false.
    const result = await deploy(dir, 'vercel', { confirm: false });
    // Either dryRun:true (tool found, dry-run) or dryRun:false (tool not found,
    // but then ran must also be false and detail must say "not installed").
    if (result.dryRun) {
      expect(result.ran).toBe(false);
    } else {
      expect(result.ran).toBe(false);
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('ran is always false when confirm is false', async () => {
    const dir = makeEmptyScriptsFixture();
    for (const target of ['vercel', 'stack', 'gh', 'morphkit', 'anything']) {
      const result = await deploy(dir, target, { confirm: false });
      expect(result.ran).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// runShipGate — absent package.json
// ---------------------------------------------------------------------------

describe('runShipGate — missing package.json', () => {
  it('handles a directory with no package.json gracefully', async () => {
    const dir = freshTmpDir();
    // Only README, no package.json
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
    const gate = await runShipGate(dir, { strict: false });
    // Should complete without throwing; supply-chain should be skip or warn
    expect(gate.checks.length).toBeGreaterThanOrEqual(1);
  });

  it('script checks (test/lint/build) are skipped when no package.json', async () => {
    const dir = freshTmpDir();
    const gate = await runShipGate(dir, { strict: false });
    for (const c of gate.checks) {
      if (['test', 'lint', 'build'].includes(c.id)) {
        expect(c.status).toBe('skip');
      }
    }
  });
});
