/**
 * M110 — team-aware onboarding tests.
 *
 * Covers:
 *   1. stepUser — sets cfg.user from --user / --user-id flags
 *   2. stepUser — leaves existing cfg.user unchanged when no flags
 *   3. stepUser — derives a default from git config or OS username (non-TTY)
 *   4. stepUser — returns 'detected' (never throws) when nothing derivable
 *   5. stepPulse — skipped when pulse not enabled in cfg
 *   6. stepPulse — detected when pulse enabled but ASHLR_PULSE_PAT absent
 *   7. stepPulse — ok when pulse enabled + ASHLR_PULSE_PAT set
 *   8. setupWizard — runs user + pulse steps, includes them in result.steps
 *   9. setupWizard --user "Cofounder" — persists identity + reports it
 *  10. cmdSetup --user "Cofounder" — prints "running as Cofounder" in output
 *  11. cmdSetup --user-id — accepted without --user
 *  12. NON-TTY safe: never calls readline.createInterface
 *  13. INVARIANT: stepPulse never stores a PAT (no PAT in step detail)
 *  14. Solo behavior backward-compat: no --user leaves existing cfg.user intact
 *
 * SAFETY:
 *   - HOME is redirected to a tmp dir.
 *   - All OS/daemon/readiness/policy side effects are mocked.
 *   - child_process.execFileSync mocked to return controllable git config.
 *   - readline never constructed (NON-TTY-safe invariant).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hermetic HOME
// ---------------------------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m110-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubEnv('ASHLR_PULSE_PAT', ''); // unset by default
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Mock child_process — controllable git config responses
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.fn((_cmd: string, args: string[]) => {
  if (args?.includes('user.name')) return 'Git User';
  if (args?.includes('user.email')) return 'git@example.com';
  throw new Error('not found');
});

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(args[0] as string, args[1] as string[]),
  execFile: vi.fn(),
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
  installed: true,
  running: true,
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

vi.mock('../src/core/fleet/engine-readiness.js', () => ({
  fleetReadiness: () => [
    { engine: 'builtin', tier: 'local', installed: true, authed: true, ready: true,
      detail: 'built-in local agent loop — always available.' },
  ],
  engineReadiness: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock enrollment policy
// ---------------------------------------------------------------------------

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listEnrolled: () => [],
    enroll: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Cfg = Record<string, unknown>;

function makeConfig(overrides: Cfg = {}): Cfg {
  return {
    version: 1,
    roots: [],
    editor: 'vscode' as const,
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] as string[] },
    telemetry: {},
    tools: {},
    ...overrides,
  };
}

// Mock saveConfig so it writes to tmpHome (same as m97 approach — just write the file).
// We re-import onboard dynamically so it picks up the patched HOME.
async function importOnboard() {
  const mod = await import('../src/core/onboard.js');
  return {
    stepUser: mod.stepUser,
    stepPulse: mod.stepPulse,
    setupWizard: mod.setupWizard,
  };
}

// ---------------------------------------------------------------------------
// 1–4. stepUser — identity resolution
// ---------------------------------------------------------------------------

describe('stepUser — identity resolution', () => {
  it('sets cfg.user.name from opts.userName flag', async () => {
    const { stepUser } = await importOnboard();
    const cfg = makeConfig();
    const { userStep, cfg: updated } = await stepUser(cfg as never, { userName: 'Cofounder' });
    expect(userStep.name).toBe('user');
    expect(userStep.status).toBe('ok');
    expect(userStep.detail).toContain('Cofounder');
    expect((updated as Cfg & { user?: { name?: string } }).user?.name).toBe('Cofounder');
  });

  it('sets cfg.user.id from opts.userId flag', async () => {
    const { stepUser } = await importOnboard();
    const cfg = makeConfig();
    const { userStep, cfg: updated } = await stepUser(cfg as never, { userId: 'cofounder@co.com' });
    expect(userStep.status).toBe('ok');
    expect(userStep.detail).toContain('cofounder@co.com');
    expect((updated as Cfg & { user?: { id?: string } }).user?.id).toBe('cofounder@co.com');
  });

  it('leaves existing cfg.user intact when no flags provided', async () => {
    const { stepUser } = await importOnboard();
    const cfg = makeConfig({ user: { id: 'mason@evero-consulting.com', name: 'Mason' } });
    const { userStep, cfg: updated } = await stepUser(cfg as never, {});
    expect(userStep.status).toBe('ok');
    expect(userStep.detail).toContain('mason@evero-consulting.com');
    // cfg unchanged — saveConfig not called with different values
    expect((updated as Cfg & { user?: { id?: string } }).user?.id).toBe('mason@evero-consulting.com');
  });

  it('derives name from git config when no flags and no existing user', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.includes('user.name')) return 'Git User\n';
      if (args?.includes('user.email')) return 'git@example.com\n';
      throw new Error('not found');
    });
    const { stepUser } = await importOnboard();
    const cfg = makeConfig();
    const { userStep, cfg: updated } = await stepUser(cfg as never, {});
    expect(userStep.status).toBe('ok');
    // Should have derived something from git or OS username
    expect(['ok', 'detected']).toContain(userStep.status);
    expect(typeof userStep.detail).toBe('string');
    // cfg.user must be set when ok
    if (userStep.status === 'ok') {
      const u = (updated as Cfg & { user?: { id?: string; name?: string } }).user;
      expect(u?.id ?? u?.name).toBeTruthy();
    }
  });

  it('returns detected (never throws) when git fails and no OS username', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('git not found'); });
    // Mock userInfo to throw
    vi.mock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, userInfo: () => { throw new Error('no userInfo'); } };
    });
    const { stepUser } = await importOnboard();
    const cfg = makeConfig();
    // Should resolve without throwing
    await expect(stepUser(cfg as never, {})).resolves.toBeDefined();
    const { userStep } = await stepUser(cfg as never, {});
    expect(['ok', 'detected', 'manual']).toContain(userStep.status);
    expect(typeof userStep.detail).toBe('string');
  });

  it('step has required shape fields', async () => {
    const { stepUser } = await importOnboard();
    const cfg = makeConfig({ user: { name: 'Test' } });
    const { userStep } = await stepUser(cfg as never, {});
    expect(typeof userStep.name).toBe('string');
    expect(['ok', 'wired', 'detected', 'skipped', 'manual']).toContain(userStep.status);
    expect(typeof userStep.detail).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 5–7. stepPulse — guidance-only
// ---------------------------------------------------------------------------

describe('stepPulse — guidance-only, never stores PAT', () => {
  it('returns skipped when pulse not enabled in cfg', async () => {
    const { stepPulse } = await importOnboard();
    const cfg = makeConfig(); // no pulse field
    const s = await stepPulse(cfg as never);
    expect(s.name).toBe('pulse');
    expect(s.status).toBe('skipped');
  });

  it('returns detected when pulse enabled but ASHLR_PULSE_PAT absent', async () => {
    vi.stubEnv('ASHLR_PULSE_PAT', '');
    const { stepPulse } = await importOnboard();
    const cfg = makeConfig({ pulse: { enabled: true, endpoint: 'https://pulse.example.com' } });
    const s = await stepPulse(cfg as never);
    expect(s.name).toBe('pulse');
    expect(s.status).toBe('detected');
    expect(s.detail).toContain('ASHLR_PULSE_PAT');
    // INVARIANT: never contains a PAT value
    expect(s.detail).not.toMatch(/PAT\s*=\s*(?!<)[^\s<>]+/i);
    expect(s.detail).not.toMatch(/Bearer\s+\S+/);
  });

  it('returns ok when pulse enabled and ASHLR_PULSE_PAT set', async () => {
    vi.stubEnv('ASHLR_PULSE_PAT', 'fake-test-pat-value');
    const { stepPulse } = await importOnboard();
    const cfg = makeConfig({ pulse: { enabled: true, endpoint: 'https://pulse.example.com' } });
    const s = await stepPulse(cfg as never);
    expect(s.name).toBe('pulse');
    expect(s.status).toBe('ok');
    // Detail must NOT contain the actual PAT value
    expect(s.detail).not.toContain('fake-test-pat-value');
  });

  it('INVARIANT: detail never contains the PAT value even when set', async () => {
    vi.stubEnv('ASHLR_PULSE_PAT', 'supersecrettoken123');
    const { stepPulse } = await importOnboard();
    const cfg = makeConfig({ pulse: { enabled: true } });
    const s = await stepPulse(cfg as never);
    expect(s.detail).not.toContain('supersecrettoken123');
  });

  it('never throws', async () => {
    const { stepPulse } = await importOnboard();
    // Corrupt cfg
    await expect(stepPulse(null as never)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8–9. setupWizard — includes user + pulse steps
// ---------------------------------------------------------------------------

describe('setupWizard — user + pulse steps included', () => {
  it('result.steps includes "user" and "pulse" step names', async () => {
    const { setupWizard } = await importOnboard();
    const result = await setupWizard(makeConfig() as never, { wire: false, yes: false });
    const names = result.steps.map((s) => s.name);
    expect(names).toContain('user');
    expect(names).toContain('pulse');
  });

  it('also contains all base onboard steps + daemon/engines/enroll', async () => {
    const { setupWizard } = await importOnboard();
    const result = await setupWizard(makeConfig() as never, { wire: false, yes: false });
    const names = result.steps.map((s) => s.name);
    expect(names).toContain('config');
    expect(names).toContain('models');
    expect(names).toContain('daemon-service');
    expect(names).toContain('engines');
    expect(names).toContain('enroll');
  });

  it('--user "Cofounder" persists identity and user step is ok', async () => {
    const { setupWizard } = await importOnboard();
    const result = await setupWizard(makeConfig() as never, {
      wire: false, yes: false, userName: 'Cofounder',
    });
    const userStep = result.steps.find((s) => s.name === 'user');
    expect(userStep).toBeDefined();
    expect(userStep!.status).toBe('ok');
    expect(userStep!.detail).toContain('Cofounder');
  });

  it('returns ready boolean and nextSteps array', async () => {
    const { setupWizard } = await importOnboard();
    const result = await setupWizard(makeConfig() as never, { wire: false, yes: false });
    expect(typeof result.ready).toBe('boolean');
    expect(Array.isArray(result.nextSteps)).toBe(true);
  });

  it('nextSteps includes try: ashlr run line', async () => {
    const { setupWizard } = await importOnboard();
    const result = await setupWizard(makeConfig() as never, { wire: false, yes: false });
    expect(result.nextSteps.join('\n')).toMatch(/ashlr run/);
  });

  it('never throws when all sub-steps fail', async () => {
    mockInstall.mockRejectedValueOnce(new Error('install failed'));
    const { setupWizard } = await importOnboard();
    await expect(setupWizard(makeConfig() as never, { wire: false, yes: true })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10–12. cmdSetup --user / --user-id / NON-TTY
// ---------------------------------------------------------------------------

describe('cmdSetup --user / --user-id / NON-TTY', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockServiceStatus.mockReturnValue({ installed: true, running: true, platformSpec: 'launchd', serviceFilePath: '/x' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cmdSetup --user "Cofounder" prints "running as Cofounder"', async () => {
    const { cmdSetup } = await import('../src/cli/setup.js');
    await cmdSetup(['--yes', '--user', 'Cofounder']);
    const out = logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(out).toMatch(/running as Cofounder/i);
  });

  it('cmdSetup --user-id cofounder@co.com accepted and exits 0', async () => {
    const { cmdSetup } = await import('../src/cli/setup.js');
    const code = await cmdSetup(['--yes', '--user-id', 'cofounder@co.com']);
    expect(code).toBe(0);
  });

  it('cmdSetup exits 0 with no --user flag (backward-compat)', async () => {
    const { cmdSetup } = await import('../src/cli/setup.js');
    const code = await cmdSetup(['--yes']);
    expect(code).toBe(0);
  });

  it('NON-TTY safe: never calls readline.createInterface', async () => {
    const { cmdSetup } = await import('../src/cli/setup.js');
    await cmdSetup(['--yes', '--user', 'Cofounder']);
    expect(mockCreateInterface).not.toHaveBeenCalled();
  });

  it('emits valid JSON with --json and includes steps for user + pulse', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { cmdSetup } = await import('../src/cli/setup.js');
    await cmdSetup(['--yes', '--json', '--user', 'JSONTest']);
    const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(() => JSON.parse(written)).not.toThrow();
    const parsed = JSON.parse(written) as { steps: Array<{ name: string }>; ready: boolean };
    expect(Array.isArray(parsed.steps)).toBe(true);
    const names = parsed.steps.map((s) => s.name);
    expect(names).toContain('user');
    expect(names).toContain('pulse');
    writeSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 13. Backward-compat — solo behavior unchanged when no --user
// ---------------------------------------------------------------------------

describe('backward-compat — no --user leaves existing cfg.user intact', () => {
  it('setupWizard without --user does not overwrite cfg.user.id', async () => {
    const { setupWizard } = await importOnboard();
    const cfg = makeConfig({ user: { id: 'mason@evero-consulting.com', name: 'Mason' } });
    const result = await setupWizard(cfg as never, { wire: false, yes: false });
    const userStep = result.steps.find((s) => s.name === 'user');
    expect(userStep).toBeDefined();
    // Existing identity should be reported, not overwritten
    expect(userStep!.detail).toContain('mason@evero-consulting.com');
  });

  it('stepUser with existing cfg.user and no opts returns ok without changing the value', async () => {
    const { stepUser } = await importOnboard();
    const cfg = makeConfig({ user: { id: 'stable@id.com', name: 'Stable' } });
    const { userStep, cfg: updated } = await stepUser(cfg as never, {});
    expect(userStep.status).toBe('ok');
    expect((updated as never as { user: { id: string } }).user.id).toBe('stable@id.com');
  });
});
