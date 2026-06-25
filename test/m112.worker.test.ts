/**
 * M112 — `ashlr worker` tests.
 *
 * Covers:
 *   1. generateServiceDefinition() with keepAwake: true → caffeinate in ProgramArguments
 *   2. generateServiceDefinition() with keepAwake: false → no caffeinate
 *   3. generateServiceDefinition() default (keepAwake omitted) → no caffeinate
 *   4. cmdWorker setup — calls setupWizard + enroll + install + prints worker summary
 *   5. cmdWorker setup --queue → sets cfg.fleet.sharedQueue.path + reported in output
 *   6. cmdWorker status → reports identity / repos / service state
 *   7. cmdWorker unknown subcommand → exits 1
 *
 * SAFETY:
 *   - HOME is redirected to a tmp dir.
 *   - spawnSync / execFileSync mocked — no OS commands run.
 *   - fs write helpers mocked — no real disk writes.
 *   - setupWizard / enroll / install / loadConfig / saveConfig are all mocked.
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
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m112-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Mock child_process (prevent real OS calls)
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  execFileSync: vi.fn(() => ''),
}));

// ---------------------------------------------------------------------------
// Mock fs (prevent real disk writes in service layer)
// ---------------------------------------------------------------------------

import * as fsModule from 'node:fs';
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mock daemon service
// ---------------------------------------------------------------------------

const mockInstall = vi.fn(async () => { /* no-op */ });
const mockServiceStatus = vi.fn(() => ({
  installed: true,
  running: true,
  platformSpec: 'launchd' as const,
  serviceFilePath: '/tmp/ai.ashlr.daemon.plist',
}));

vi.mock('../src/core/daemon/service.js', () => ({
  install: (...args: unknown[]) => mockInstall(...args),
  serviceStatus: (...args: unknown[]) => mockServiceStatus(...args),
  generateServiceDefinition: vi.fn(),
  uninstall: vi.fn(),
  execFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock enrollment policy
// ---------------------------------------------------------------------------

const mockEnroll = vi.fn();
const mockListEnrolled = vi.fn(() => [] as string[]);

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    enroll: (...args: unknown[]) => mockEnroll(...args),
    listEnrolled: () => mockListEnrolled(),
  };
});

// ---------------------------------------------------------------------------
// Mock onboard (setupWizard)
// ---------------------------------------------------------------------------

const mockSetupWizard = vi.fn(async () => ({
  steps: [],
  ready: true,
  nextSteps: ['add engine auth: ashlr config set engines.apiKey <key>'],
}));

vi.mock('../src/core/onboard.js', () => ({
  setupWizard: (...args: unknown[]) => mockSetupWizard(...args),
}));

// ---------------------------------------------------------------------------
// Mock config (loadConfig / saveConfig)
// ---------------------------------------------------------------------------

let fakeConfig: Record<string, unknown> = { roots: [], version: 1 };

// Track saveConfig calls for assertions
let savedConfigs: Record<string, unknown>[] = [];

vi.mock('../src/core/config.js', () => ({
  loadConfig:  () => ({ ...fakeConfig }),
  saveConfig:  (cfg: unknown) => {
    fakeConfig = { ...(cfg as Record<string, unknown>) };
    savedConfigs.push(fakeConfig);
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function importWorker() {
  const mod = await import('../src/cli/worker.js');
  return { cmdWorker: mod.cmdWorker };
}

// Capture console output; strips ANSI escape codes for clean assertions
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function captureConsole() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { lines.push(stripAnsi(a.join(' '))); });
  vi.spyOn(console, 'warn').mockImplementation((...a) => { lines.push(stripAnsi(a.join(' '))); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { lines.push(stripAnsi(a.join(' '))); });
  return { lines };
}

// Note: keepAwake plist generation tests live in test/m112.keepawake.test.ts
// (separate file without the service module mock).

// DEAD DESCRIBE BLOCK REMOVED — see m112.keepawake.test.ts

// ---------------------------------------------------------------------------
// Suite 2 — cmdWorker setup
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Suite 2 — cmdWorker setup
// ---------------------------------------------------------------------------

describe('M112 — cmdWorker setup', () => {
  beforeEach(() => {
    fakeConfig = { roots: [], version: 1 };
    savedConfigs = [];
    mockSetupWizard.mockClear();
    mockInstall.mockClear();
    mockEnroll.mockClear();
    mockListEnrolled.mockReturnValue([]);
  });

  it('calls setupWizard + installService with keepAwake: true', async () => {
    const { cmdWorker } = await importWorker();
    const { lines } = captureConsole();

    const exit = await cmdWorker(['setup', '--user', 'WorkerBot', '--yes']);

    expect(exit).toBe(0);
    expect(mockSetupWizard).toHaveBeenCalledOnce();
    // setupWizard(cfg, opts) — opts is the second argument (index 1)
    expect(mockSetupWizard.mock.calls[0]?.[1]).toMatchObject({ userName: 'WorkerBot', yes: true });
    expect(mockInstall).toHaveBeenCalledWith(expect.objectContaining({ keepAwake: true }));
    const output = lines.join('\n');
    expect(output).toMatch(/worker/i);
  });

  it('enrolls repos from --repos flag', async () => {
    const { cmdWorker } = await importWorker();
    captureConsole();

    await cmdWorker(['setup', '--user', 'WorkerBot', '--repos', '/repo/a,/repo/b', '--yes']);

    expect(mockEnroll).toHaveBeenCalledWith('/repo/a');
    expect(mockEnroll).toHaveBeenCalledWith('/repo/b');
  });

  it('--queue sets cfg.fleet.sharedQueue.path', async () => {
    const { cmdWorker } = await importWorker();
    captureConsole();

    await cmdWorker(['setup', '--user', 'WorkerBot', '--queue', '/shared/queue', '--yes']);

    // saveConfig must have been called — fakeConfig mutated in place
    const fleet = fakeConfig.fleet as Record<string, unknown> | undefined;
    const sharedQ = fleet?.sharedQueue as { path?: string } | undefined;
    expect(sharedQ?.path).toBe('/shared/queue');
  });

  it('--queue path appears in status output when config carries it', async () => {
    // fakeConfig carries the sharedQueue so loadConfig() returns it in the summary print
    fakeConfig = { roots: [], version: 1, user: { name: 'WorkerBot' }, fleet: { sharedQueue: { path: '/shared/queue' } } };
    const { cmdWorker } = await importWorker();
    const { lines } = captureConsole();

    await cmdWorker(['status']);

    expect(lines.join('\n')).toContain('/shared/queue');
  });

  it('worker summary mentions keepAwake and subscription engine tip', async () => {
    const { cmdWorker } = await importWorker();
    const { lines } = captureConsole();

    await cmdWorker(['setup', '--user', 'Aria', '--yes']);

    const output = lines.join('\n');
    expect(output).toMatch(/caffeinate/i);
    expect(output).toMatch(/subscription|8\s*GB|providerChain/i);
  });

  it('prints nextSteps from setupWizard result', async () => {
    mockSetupWizard.mockResolvedValueOnce({
      steps: [],
      ready: true,
      nextSteps: ['TEST_NEXT_STEP_TOKEN'],
    });
    const { cmdWorker } = await importWorker();
    const { lines } = captureConsole();

    await cmdWorker(['setup', '--yes']);

    expect(lines.join('\n')).toContain('TEST_NEXT_STEP_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — cmdWorker status
// ---------------------------------------------------------------------------

describe('M112 — cmdWorker status', () => {
  beforeEach(() => {
    fakeConfig = { roots: [], version: 1 };
    savedConfigs = [];
    mockServiceStatus.mockClear();
    mockListEnrolled.mockReturnValue(['/repo/x']);
  });

  it('reports identity, repos, service state', async () => {
    fakeConfig = { roots: [], version: 1, user: { name: 'Aria', id: 'aria@example.com' } };
    mockServiceStatus.mockReturnValue({
      installed: true,
      running: true,
      platformSpec: 'launchd' as const,
      serviceFilePath: '/tmp/ai.ashlr.daemon.plist',
    });

    const { cmdWorker } = await importWorker();
    const { lines } = captureConsole();

    const exit = await cmdWorker(['status']);

    expect(exit).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('Aria');
    expect(output).toContain('/repo/x');
    expect(output).toMatch(/running/i);
    expect(output).toMatch(/launchd/i);
  });

  it('reports "standalone" when no sharedQueue configured', async () => {
    fakeConfig = { roots: [], version: 1, user: { name: 'Bot' } };

    const { cmdWorker } = await importWorker();
    const { lines } = captureConsole();

    await cmdWorker(['status']);

    expect(lines.join('\n')).toMatch(/standalone/i);
  });

  it('reports shared queue path when configured', async () => {
    fakeConfig = { roots: [], version: 1, user: { name: 'Bot' }, fleet: { sharedQueue: { path: '/shared/q' } } };

    const { cmdWorker } = await importWorker();
    const { lines } = captureConsole();

    await cmdWorker(['status']);

    expect(lines.join('\n')).toContain('/shared/q');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — error handling
// ---------------------------------------------------------------------------

describe('M112 — cmdWorker error paths', () => {
  it('unknown subcommand → exits 1', async () => {
    const { cmdWorker } = await importWorker();
    captureConsole();

    const exit = await cmdWorker(['unknown-sub']);

    expect(exit).toBe(1);
  });

  it('no subcommand → exits 1', async () => {
    const { cmdWorker } = await importWorker();
    captureConsole();

    const exit = await cmdWorker([]);

    expect(exit).toBe(1);
  });
});
