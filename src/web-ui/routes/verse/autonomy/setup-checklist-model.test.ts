import { describe, expect, it } from 'vitest';
import { setupReport } from '../command/fixtures.test-support.js';
import { SETUP_COMMAND, detailParts, narrowSetupReport, nextCommand, nextRow, safeSetupLink, setupProgress, setupReadiness, setupRows } from './setup-checklist-model.js';

describe('setupReadiness', () => {
  it('ready only when the grant is the next step; setup while an earlier one is open; unknown without an answer', () => {
    expect(setupReadiness(undefined)).toBeUndefined();
    expect(setupReadiness({ value: null })).toBe('unknown');
    expect(setupReadiness({ value: setupReport('standing-grant') })).toBe('ready');
    for (const next of ['custody-helper', 'trust-root', 'deploy', 'github-app', 'rulesets', 'provenance-key']) {
      expect(setupReadiness({ value: setupReport(next) }), next).toBe('setup');
    }
  });
});

describe('the checklist rows', () => {
  it('marks every step: done, the one next, to do, and the build block', () => {
    const report = setupReport('github-app');
    const rows = setupRows(report);
    expect(rows).toHaveLength(15);
    expect(rows.slice(0, 5).every((r) => r.mark === 'done')).toBe(true);
    expect(rows.find((r) => r.id === 'github-app')).toMatchObject({ label: 'GitHub App', mark: 'next', needs: [{ id: 'browser', label: 'Browser' }, { id: 'github', label: 'GitHub' }] });
    expect(rows.find((r) => r.id === 'custody-helper')?.label).toBe('Custody helper');
    expect(rows.find((r) => r.id === 'signing-key')?.needs).toEqual([{ id: 'touch-id', label: 'Touch ID' }]);
    expect(rows.find((r) => r.id === 'claude-token')?.mark).toBe('todo');
    expect(rows.find((r) => r.id === 'resident-runtime')?.mark).toBe('blocked');
    expect(setupProgress(report)).toEqual({ ready: 5, total: 15 });
    expect(nextRow(report)?.id).toBe('github-app');
  });

  it('a failed step reads failed, wherever it sits', () => {
    const report = setupReport('host-binding', { 'host-binding': { status: 'failed' } });
    expect(nextRow(report)?.mark).toBe('failed');
    expect(nextCommand(report)).toBe('sudo scripts/install-custody.sh');
  });

  it('the one command: the step’s own, else setup; nothing when the next step is a build block', () => {
    expect(nextCommand(null)).toBe(SETUP_COMMAND);
    expect(nextCommand(setupReport('custody-helper'))).toBe('sudo scripts/install-custody.sh');
    expect(nextCommand(setupReport('deploy'))).toBe('npm run build');
    expect(nextCommand(setupReport('rulesets'))).toBe(SETUP_COMMAND);
    expect(nextCommand(setupReport('github-app', { 'github-app': { command: undefined } }))).toBe(SETUP_COMMAND);
    expect(nextCommand(setupReport('resident-runtime'))).toBeNull();
    // A blocked step offers the command it names itself (the grant unblocks the resident step).
    expect(nextCommand(setupReport('resident-runtime', { 'resident-runtime': { command: 'ashlr authority grant' } }))).toBe('ashlr authority grant');
    expect(nextCommand(setupReport('daemon-service'))).toBe('ashlr authority resident start');
  });

  it('renders the CLI’s detail with its backticked commands as code, sentence-cased', () => {
    expect(detailParts('run `sudo scripts/install-custody.sh` from the ashlr-hub checkout')).toEqual([
      { text: 'Run ', code: false },
      { text: 'sudo scripts/install-custody.sh', code: true },
      { text: ' from the ashlr-hub checkout', code: false },
    ]);
    expect(detailParts('`npm run build` first')).toEqual([{ text: 'npm run build', code: true }, { text: ' first', code: false }]);
    expect(detailParts('a lone ` backtick')).toEqual([{ text: 'A lone ` backtick', code: false }]);
  });

  it('opens only plain https://github.com/ pages', () => {
    expect(safeSetupLink('https://github.com/apps/ashlr-fleet/installations/new')).toBe('https://github.com/apps/ashlr-fleet/installations/new');
    expect(safeSetupLink('https://github.com/ashlrai/ashlr-hub/pull/9')).toBe('https://github.com/ashlrai/ashlr-hub/pull/9');
    expect(safeSetupLink('http://github.com/x')).toBeNull();
    expect(safeSetupLink('https://github.com.evil.example/x')).toBeNull();
    expect(safeSetupLink('https://user:pw@github.com/x')).toBeNull();
    expect(safeSetupLink('javascript:alert(1)')).toBeNull();
    expect(safeSetupLink(null)).toBeNull();
  });

  it('narrows only the v1 schema with renderable steps', () => {
    expect(narrowSetupReport(setupReport())).not.toBeNull();
    expect(narrowSetupReport({ ...setupReport(), schema: 'other' })).toBeNull();
    expect(narrowSetupReport({ ...setupReport(), steps: [{ id: 'x' }] })).toBeNull();
    expect(narrowSetupReport({ v: 1, switch: 'off', grant: {} })).toBeNull();
  });
});
