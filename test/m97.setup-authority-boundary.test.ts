import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const effects = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  setupWizard: vi.fn(),
}));

vi.mock('../src/core/config.js', () => ({
  loadConfig: effects.loadConfig,
}));

vi.mock('../src/core/onboard.js', () => ({
  setupWizard: effects.setupWizard,
}));

/**
 * A resident-authority refusal is now audited (M21 append-only audit trail —
 * every daemon-activation:install-check is logged, granted or denied). That
 * audit write is the ONLY footprint a refusal may leave: no config, no
 * onboarding/wizard state, no service/control files. Assert the shape
 * precisely rather than allowing a loose "some file exists" check to
 * silently accept a future regression that starts touching real state.
 */
function expectOnlyAuditTrailWasWritten(home: string): void {
  expect(readdirSync(home)).toEqual(['.ashlr']);
  expect(readdirSync(join(home, '.ashlr'))).toEqual(['audit']);
  const auditFiles = readdirSync(join(home, '.ashlr', 'audit'));
  expect(auditFiles).toHaveLength(1);
  expect(auditFiles[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-setup-authority-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('cmdSetup resident authority boundary', () => {
  it.each([
    { args: [] },
    { args: ['--yes'] },
    { args: ['--wire', '--user', 'operator'] },
  ])(
    'refuses $args before config or wizard effects and leaves a fresh HOME empty',
    async ({ args }) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...values) => stdout.push(values.map(String).join(' ')));
      vi.spyOn(console, 'error').mockImplementation((...values) => stderr.push(values.map(String).join(' ')));
      const { cmdSetup } = await import('../src/cli/setup.js');

      const code = await cmdSetup(args);

      expect(code).toBe(1);
      expect(effects.loadConfig).not.toHaveBeenCalled();
      expect(effects.setupWizard).not.toHaveBeenCalled();
      expect(stderr.join('\n')).toContain('setup refused before config or wizard work');
      expect(stdout.join('\n')).toContain('ashlr daemon start --once');
      expect(stdout.join('\n')).not.toContain('setup complete');
      expectOnlyAuditTrailWasWritten(home);
    },
  );

  it('returns a ready:false JSON refusal without invoking effects', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const { cmdSetup } = await import('../src/cli/setup.js');

    const code = await cmdSetup(['--json']);
    const result = JSON.parse(writes.join('')) as {
      ready: boolean;
      steps: Array<{ detail: string }>;
      nextSteps: string[];
    };

    expect(code).toBe(1);
    expect(result.ready).toBe(false);
    expect(result.steps[0]?.detail).toContain('No setup state was inspected or changed');
    expect(result.nextSteps).toEqual(['try: ashlr daemon start --once']);
    expect(effects.loadConfig).not.toHaveBeenCalled();
    expect(effects.setupWizard).not.toHaveBeenCalled();
    expectOnlyAuditTrailWasWritten(home);
  });
});
