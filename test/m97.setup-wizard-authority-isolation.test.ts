import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

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
      nextSteps: ['try: ashlr daemon start --once'],
      steps: [{ name: 'daemon-service', status: 'manual' }],
    });
    expect(result.steps[0]?.detail).toContain('setup refused before onboarding');
    expect(result.steps[0]?.detail).toContain('No setup state was inspected or changed');
    expectOnlyAuditTrailWasWritten(home);
  });
});
