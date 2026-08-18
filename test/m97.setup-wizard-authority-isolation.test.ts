import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-setup-wizard-authority-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('exported setupWizard production authority boundary', () => {
  it('returns ready:false before any real onboarding effect and leaves HOME empty', async () => {
    const cfg = {
      version: 1,
      roots: [],
      editor: 'vscode',
      staleDays: 30,
      categories: {},
      tidyRules: [],
      keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] },
      telemetry: {},
      tools: {},
    } as AshlrConfig;
    const { setupWizard } = await import('../src/core/onboard.js');

    const result = await setupWizard(cfg, { wire: true, yes: true, userName: 'must-not-persist' });

    expect(result).toMatchObject({
      ready: false,
      nextSteps: [
        'try: ashlr run "<goal>"',
        'try: ashlr swarm "<goal>"',
        'try: ashlr daemon start --once --dry-run',
      ],
      steps: [{ name: 'daemon-service', status: 'manual' }],
    });
    expect(result.steps[0]?.detail).toContain('setup refused before onboarding');
    expect(result.steps[0]?.detail).toContain('No setup state was inspected or changed');
    expect(readdirSync(home)).toEqual([]);
  });
});
