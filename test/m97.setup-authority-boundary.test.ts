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
      expect(stdout.join('\n')).toContain('ashlr run "<goal>"');
      expect(stdout.join('\n')).toContain('ashlr swarm "<goal>"');
      expect(stdout.join('\n')).toContain('ashlr daemon start --once --dry-run');
      expect(stdout.join('\n')).not.toContain('setup complete');
      expect(readdirSync(home)).toEqual([]);
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
    expect(result.nextSteps).toEqual([
      'try: ashlr run "<goal>"',
      'try: ashlr swarm "<goal>"',
      'try: ashlr daemon start --once --dry-run',
    ]);
    expect(effects.loadConfig).not.toHaveBeenCalled();
    expect(effects.setupWizard).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });
});
