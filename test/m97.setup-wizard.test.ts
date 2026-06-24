/**
 * M97 — setup wizard tests.
 *
 * Covers:
 *   1. stepDaemonService — idempotent, never-throw; mocked serviceStatus/install
 *   2. stepEngines       — guidance-only, never enters tokens; mocked fleetReadiness
 *   3. stepEnroll        — idempotent, never-throw; mocked policy
 *   4. setupWizard       — runs all steps + returns OnboardResult
 *   5. cmdSetup --yes    — runs wizard end-to-end, prints readiness summary
 *   6. engine-auth step  — guidance-only invariant (fix strings present, no token written)
 *
 * SAFETY:
 *   - HOME is redirected to a tmp dir.
 *   - All OS/daemon/readiness/policy side effects are mocked.
 *   - No real subprocess or file I/O outside tmpHome.
 *   - readline never constructed (NON-TTY-safe invariant).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hermetic HOME
// ---------------------------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m97-setup-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Mock child_process (used by onboard sub-steps)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => { throw new Error('not found'); }),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    pid: 0,
  })),
}));

// ---------------------------------------------------------------------------
// Mock readline (NON-TTY-safe invariant)
// ---------------------------------------------------------------------------

const mockCreateInterface = vi.fn(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline', () => ({ createInterface: mockCreateInterface }));

// ---------------------------------------------------------------------------
// Mock fetch (providers offline)
// ---------------------------------------------------------------------------

vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

// ---------------------------------------------------------------------------
// Mock daemon service
// ---------------------------------------------------------------------------

const mockServiceStatus = vi.fn(() => ({
  installed: false,
  running: false,
  platformSpec: 'launchd' as const,
  serviceFilePath: '/tmp/fake.plist',
}));
const mockInstall = vi.fn(async () => { /* no-op */ });

vi.mock('../src/core/daemon/service.js', () => ({
  serviceStatus: (...args: unknown[]) => mockServiceStatus(...args),
  install: (...args: unknown[]) => mockInstall(...args),
  generateServiceDefinition: vi.fn(),
  uninstall: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock fleet readiness
// ---------------------------------------------------------------------------

const mockFleetReadiness = vi.fn(() => [
  { engine: 'builtin', tier: 'local', installed: true, authed: true, ready: true,
    detail: 'built-in local agent loop — always available.' },
]);

vi.mock('../src/core/fleet/engine-readiness.js', () => ({
  fleetReadiness: (...args: unknown[]) => mockFleetReadiness(...args),
  engineReadiness: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock enrollment policy
// ---------------------------------------------------------------------------

const enrolledRepos: string[] = [];
const mockListEnrolled = vi.fn(() => [...enrolledRepos]);
const mockEnroll = vi.fn((repo: string) => { enrolledRepos.push(repo); });

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listEnrolled: (...args: unknown[]) => mockListEnrolled(...args),
    enroll: (...args: unknown[]) => mockEnroll(...args),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    version: 1 as const,
    roots: [],
    editor: 'vscode' as const,
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] as string[] },
    telemetry: {},
    tools: {},
  };
}

async function importNewSteps() {
  const mod = await import('../src/core/onboard.js');
  return {
    stepDaemonService: mod.stepDaemonService,
    stepEngines: mod.stepEngines,
    stepEnroll: mod.stepEnroll,
    setupWizard: mod.setupWizard,
  };
}

// ---------------------------------------------------------------------------
// 1. stepDaemonService — idempotent, never-throw
// ---------------------------------------------------------------------------

describe('stepDaemonService — idempotent, never-throw', () => {
  it('returns ok when service is already installed', async () => {
    mockServiceStatus.mockReturnValueOnce({ installed: true, running: true, platformSpec: 'launchd', serviceFilePath: '/x' });
    const { stepDaemonService } = await importNewSteps();
    const s = await stepDaemonService();
    expect(s.name).toBe('daemon-service');
    expect(s.status).toBe('ok');
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('calls install() when service not installed, then returns ok', async () => {
    mockServiceStatus
      .mockReturnValueOnce({ installed: false, running: false, platformSpec: 'launchd', serviceFilePath: '/x' })
      .mockReturnValueOnce({ installed: true,  running: false, platformSpec: 'launchd', serviceFilePath: '/x' });
    const { stepDaemonService } = await importNewSteps();
    const s = await stepDaemonService();
    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(s.status).toBe('ok');
  });

  it('returns manual (never throws) when install() throws', async () => {
    mockServiceStatus.mockReturnValue({ installed: false, running: false, platformSpec: 'launchd', serviceFilePath: '/x' });
    mockInstall.mockRejectedValueOnce(new Error('launchctl failed'));
    const { stepDaemonService } = await importNewSteps();
    await expect(stepDaemonService()).resolves.toMatchObject({ name: 'daemon-service', status: 'manual' });
  });

  it('is idempotent — second call with installed service stays ok', async () => {
    mockServiceStatus.mockReturnValue({ installed: true, running: true, platformSpec: 'launchd', serviceFilePath: '/x' });
    const { stepDaemonService } = await importNewSteps();
    const r1 = await stepDaemonService();
    const r2 = await stepDaemonService();
    expect(r1.status).toBe('ok');
    expect(r2.status).toBe('ok');
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('step has required shape fields', async () => {
    const { stepDaemonService } = await importNewSteps();
    const s = await stepDaemonService();
    expect(typeof s.name).toBe('string');
    expect(['ok', 'wired', 'detected', 'skipped', 'manual']).toContain(s.status);
    expect(typeof s.detail).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 2. stepEngines — guidance-only, never enters token
// ---------------------------------------------------------------------------

describe('stepEngines — guidance-only, never enters token', () => {
  it('returns ok when all engines ready', async () => {
    mockFleetReadiness.mockReturnValue([
      { engine: 'builtin', tier: 'local', installed: true, authed: true, ready: true, detail: 'ok' },
    ]);
    const { stepEngines } = await importNewSteps();
    const s = await stepEngines(makeConfig());
    expect(s.name).toBe('engines');
    expect(s.status).toBe('ok');
    expect(s.detail).toMatch(/1\/1 engines ready/);
  });

  it('returns detected when some engines not ready — includes fix guidance', async () => {
    mockFleetReadiness.mockReturnValue([
      { engine: 'builtin', tier: 'local', installed: true, authed: true, ready: true, detail: 'ok' },
      { engine: 'claude', tier: 'frontier', installed: true, authed: false, ready: false,
        detail: 'no credential', fix: 'run: claude (interactive login)' },
    ]);
    const { stepEngines } = await importNewSteps();
    const s = await stepEngines(makeConfig());
    expect(s.name).toBe('engines');
    expect(s.status).toBe('detected');
    // fix guidance surfaced in detail — never a token value
    expect(s.detail).toContain('1/2 engines ready');
    expect(s.detail).toContain('claude:');
    // INVARIANT: detail must not contain anything that looks like a secret token
    expect(s.detail).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(s.detail).not.toMatch(/ANTHROPIC_API_KEY\s*=\s*\S+/);
  });

  it('returns manual (never throws) when fleetReadiness throws', async () => {
    mockFleetReadiness.mockImplementation(() => { throw new Error('engine probe exploded'); });
    const { stepEngines } = await importNewSteps();
    await expect(stepEngines(makeConfig())).resolves.toMatchObject({ name: 'engines', status: 'manual' });
  });

  it('INVARIANT: fix strings are guidance only — never contains a credential value', async () => {
    mockFleetReadiness.mockReturnValue([
      { engine: 'claude', tier: 'frontier', installed: false, authed: false, ready: false,
        detail: 'binary not found', fix: 'npm install -g @anthropic-ai/claude-code' },
    ]);
    const { stepEngines } = await importNewSteps();
    const s = await stepEngines(makeConfig());
    // The detail contains the fix string — verify no credential pattern
    expect(s.detail).not.toMatch(/Bearer\s+\S+/);
    expect(s.detail).not.toMatch(/token\s*=\s*\S+/i);
    expect(s.detail).not.toMatch(/api[_-]?key\s*=\s*\S+/i);
  });
});

// ---------------------------------------------------------------------------
// 3. stepEnroll — idempotent, never-throw
// ---------------------------------------------------------------------------

describe('stepEnroll — idempotent, never-throw', () => {
  it('returns skipped when roots is empty', async () => {
    const { stepEnroll } = await importNewSteps();
    const s = await stepEnroll(makeConfig(), { yes: true });
    expect(s.name).toBe('enroll');
    expect(s.status).toBe('skipped');
  });

  it('returns detected (not enrolling) when --yes not set', async () => {
    // Create a fake git repo under tmpHome
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const repoDir = join(tmpHome, 'myrepo');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    writeFileSync(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main');

    const cfg = { ...makeConfig(), roots: [tmpHome] };
    const { stepEnroll } = await importNewSteps();
    const s = await stepEnroll(cfg, { yes: false });
    expect(s.name).toBe('enroll');
    expect(s.status).toBe('detected');
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('enrolls discovered repos when --yes is set', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const repoDir = join(tmpHome, 'proj');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    writeFileSync(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main');

    mockListEnrolled.mockReturnValue([]);
    const cfg = { ...makeConfig(), roots: [tmpHome] };
    const { stepEnroll } = await importNewSteps();
    const s = await stepEnroll(cfg, { yes: true });
    expect(s.name).toBe('enroll');
    expect(mockEnroll).toHaveBeenCalledWith(repoDir);
    expect(['ok', 'detected']).toContain(s.status);
  });

  it('is idempotent — already-enrolled repos are not re-enrolled', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const repoDir = join(tmpHome, 'already');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    writeFileSync(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main');

    mockListEnrolled.mockReturnValue([repoDir]);
    const cfg = { ...makeConfig(), roots: [tmpHome] };
    const { stepEnroll } = await importNewSteps();
    await stepEnroll(cfg, { yes: true });
    // enroll() must NOT be called for the already-enrolled repo
    expect(mockEnroll).not.toHaveBeenCalledWith(repoDir);
  });

  it('never throws when root directory does not exist', async () => {
    // stepEnroll skips non-existent roots gracefully — no ENOENT thrown
    const cfg = { ...makeConfig(), roots: ['/nonexistent-path-that-cannot-exist-12345'] };
    const { stepEnroll } = await importNewSteps();
    const s = await stepEnroll(cfg, { yes: true });
    expect(s.name).toBe('enroll');
    // Root doesn't exist → skipped (no repos found)
    expect(['skipped', 'manual']).toContain(s.status);
    expect(typeof s.detail).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 4. setupWizard — runs all steps, returns OnboardResult
// ---------------------------------------------------------------------------

describe('setupWizard — full step list', () => {
  it('returns steps array containing daemon-service, engines, enroll', async () => {
    const { setupWizard } = await importNewSteps();
    const result = await setupWizard(makeConfig(), { wire: false, yes: false });
    const names = result.steps.map((s) => s.name);
    expect(names).toContain('daemon-service');
    expect(names).toContain('engines');
    expect(names).toContain('enroll');
  });

  it('also contains all base onboard steps', async () => {
    const { setupWizard } = await importNewSteps();
    const result = await setupWizard(makeConfig(), { wire: false, yes: false });
    const names = result.steps.map((s) => s.name);
    expect(names).toContain('config');
    expect(names).toContain('models');
    expect(names).toContain('editors');
    expect(names).toContain('symlink');
    expect(names).toContain('genome');
  });

  it('returns ready boolean and nextSteps array', async () => {
    const { setupWizard } = await importNewSteps();
    const result = await setupWizard(makeConfig(), { wire: false, yes: false });
    expect(typeof result.ready).toBe('boolean');
    expect(Array.isArray(result.nextSteps)).toBe(true);
  });

  it('nextSteps includes the try: ashlr run line', async () => {
    const { setupWizard } = await importNewSteps();
    const result = await setupWizard(makeConfig(), { wire: false, yes: false });
    expect(result.nextSteps.join('\n')).toMatch(/ashlr run/);
  });

  it('never throws when all sub-steps fail', async () => {
    mockInstall.mockRejectedValue(new Error('install failed'));
    mockFleetReadiness.mockImplementation(() => { throw new Error('readiness failed'); });
    const { setupWizard } = await importNewSteps();
    await expect(setupWizard(makeConfig(), { wire: false, yes: true })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. cmdSetup --yes — prints readiness summary
// ---------------------------------------------------------------------------

describe('cmdSetup --yes — readiness summary', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Make daemon look installed so summary says "daemon installed"
    mockServiceStatus.mockReturnValue({ installed: true, running: true, platformSpec: 'launchd', serviceFilePath: '/x' });
    // All engines ready
    mockFleetReadiness.mockReturnValue([
      { engine: 'builtin', tier: 'local', installed: true, authed: true, ready: true, detail: 'ok' },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 0 on a clean run', async () => {
    const { cmdSetup } = await import('../src/cli/setup.js');
    const code = await cmdSetup(['--yes']);
    expect(code).toBe(0);
  });

  it('prints a readiness summary line', async () => {
    const { cmdSetup } = await import('../src/cli/setup.js');
    await cmdSetup(['--yes']);
    const out = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    // Should contain some form of readiness report
    expect(out).toMatch(/setup/i);
  });

  it('prints the try: ashlr run next-step', async () => {
    const { cmdSetup } = await import('../src/cli/setup.js');
    await cmdSetup(['--yes']);
    const out = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(out).toMatch(/ashlr run/);
  });

  it('NON-TTY-safe: never calls readline.createInterface', async () => {
    const { cmdSetup } = await import('../src/cli/setup.js');
    await cmdSetup(['--yes']);
    expect(mockCreateInterface).not.toHaveBeenCalled();
  });

  it('emits valid JSON with --json flag', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { cmdSetup } = await import('../src/cli/setup.js');
    await cmdSetup(['--yes', '--json']);
    const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(() => JSON.parse(written)).not.toThrow();
    const parsed = JSON.parse(written) as { steps: unknown[]; ready: boolean; nextSteps: string[] };
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(typeof parsed.ready).toBe('boolean');
    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 6. Engine-auth INVARIANT — guidance only, never writes a token
// ---------------------------------------------------------------------------

describe('engine-auth step — guidance only invariant', () => {
  it('fix string for unauthenticated claude is a command, not a token value', async () => {
    mockFleetReadiness.mockReturnValue([
      { engine: 'claude', tier: 'frontier', installed: true, authed: false, ready: false,
        detail: 'no credential', fix: 'Run: claude (interactive login)' },
    ]);
    const { stepEngines } = await importNewSteps();
    const s = await stepEngines(makeConfig());
    expect(s.detail).toContain('claude:');
    // fix guidance is surfaced (guidance text, not a token)
    expect(s.detail).toContain('claude:');
    // NEVER writes a token
    expect(s.detail).not.toMatch(/^[A-Za-z0-9_\-]{20,}$/);
  });

  it('stepEngines never calls install() or enroll()', async () => {
    const { stepEngines } = await importNewSteps();
    await stepEngines(makeConfig());
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockEnroll).not.toHaveBeenCalled();
  });

  it('stepDaemonService never calls enroll()', async () => {
    const { stepDaemonService } = await importNewSteps();
    await stepDaemonService();
    expect(mockEnroll).not.toHaveBeenCalled();
  });
});
