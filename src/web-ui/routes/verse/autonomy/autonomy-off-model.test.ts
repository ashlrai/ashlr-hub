import { describe, expect, it } from 'vitest';
import { authorityStatus, DARK_SINCE, fleetLive } from '../command/fixtures.test-support.js';
import { darkSinceLabel } from '../fleet/dark-since.js';
import { setupReport } from '../command/fixtures.test-support.js';
import { SETUP_COMMAND, autonomyOffState } from './autonomy-off-model.js';

const NOW = Date.parse('2026-09-25T15:00:00Z');
const dark = fleetLive('dark', NOW);
const noGrant = authorityStatus('dark', NOW);

describe('autonomyOffState', () => {
  it('is null for an active, producing fleet — and before anything has answered', () => {
    expect(autonomyOffState({ authority: authorityStatus('live', NOW), live: fleetLive('live', NOW) })).toBeNull();
    expect(autonomyOffState({ authority: null, live: null })).toBeNull();
  });

  it('asks for the next setup step while one before the grant is open — its own command, and the checklist', () => {
    const report = setupReport('github-app');
    const s = autonomyOffState({ authority: noGrant, live: dark, readiness: 'setup', setup: report })!;
    expect(s.kind).toBe('setup');
    expect(s.title).toBe('Autonomy is off');
    expect(s.why).toBe('Nothing runs or merges on its own until the one-time setup is done.');
    expect(s.command).toBe(SETUP_COMMAND);
    expect(s.setup).toBe(report);
    expect(s.grant).toBeNull();
    // THE dark-since instant, as the viewer's local day.
    expect(s.since).toBe(`Fleet dark since ${darkSinceLabel(DARK_SINCE)}`);
    // A step only Mason runs names its own command (the helper needs sudo).
    expect(autonomyOffState({ authority: noGrant, live: dark, readiness: 'setup', setup: setupReport('custody-helper') })!.command).toBe('sudo scripts/install-custody.sh');
    // The checklist did not answer, but it said setup: the command that walks every step.
    expect(autonomyOffState({ authority: noGrant, live: dark, readiness: 'setup', setup: null })!.command).toBe(SETUP_COMMAND);
  });

  it('asks for a grant when only the grant is left (or the checklist did not answer)', () => {
    for (const readiness of ['ready', 'unknown'] as const) {
      const s = autonomyOffState({ authority: noGrant, live: dark, readiness, setup: readiness === 'ready' ? setupReport() : null })!;
      expect(s.kind).toBe('grant');
      expect(`${s.title}. ${s.why}`).toBe('Autonomy is off. Approve a standing grant to let the fleet work.');
      expect(s.grant).toEqual({ intent: 'grant', label: 'Approve grant' });
      expect(s.go).toEqual({ section: 'command', anchor: null, label: 'Approve in Command' });
      expect(s.command).toBeNull();
    }
  });

  it('carries no checklist once a grant exists', () => {
    const lapsed = autonomyOffState({ authority: authorityStatus('live', NOW, { grant: { ...authorityStatus('live', NOW).grant, state: 'expired' } }), live: dark, readiness: 'setup', setup: setupReport('github-app') })!;
    expect(lapsed).toMatchObject({ kind: 'grant', setup: null });
  });

  it('words a lapsed grant by its state and re-approves a paused one', () => {
    const lapsed = (state: 'expired' | 'revoked' | 'invalid' | 'paused') =>
      autonomyOffState({ authority: authorityStatus('live', NOW, { grant: { ...authorityStatus('live', NOW).grant, state } }), live: dark })!;
    expect(lapsed('expired').title).toBe('Grant expired');
    expect(lapsed('revoked').title).toBe('Grant revoked');
    expect(lapsed('invalid').why).toBe('Autonomy is off until you approve a new grant.');
    expect(lapsed('paused')).toMatchObject({ title: 'Grant paused', why: 'Autonomy is off until you re-approve it.', grant: { intent: 're-approve' } });
  });

  it('puts Stop first, whatever the grant says', () => {
    const s = autonomyOffState({ authority: authorityStatus('live', NOW, { kill: true }), live: { ...fleetLive('live', NOW), state: 'stopped' } })!;
    expect(s).toMatchObject({ kind: 'stopped', title: 'Fleet stopped', go: { section: 'command' } });
  });

  it('says the switch holds autonomy at Off under an active grant', () => {
    const off = authorityStatus('live', NOW, { switch: 'off', effectiveSwitch: 'off' });
    expect(autonomyOffState({ authority: off, live: fleetLive('live', NOW) })).toMatchObject({ kind: 'off', why: 'Switch it to Propose or Autonomous to start the fleet.' });
    const held = authorityStatus('live', NOW, { switch: 'propose', effectiveSwitch: 'off', effectiveReason: 'No OS confinement on this Mac' });
    expect(autonomyOffState({ authority: held, live: fleetLive('live', NOW) })!.why).toBe('No OS confinement on this Mac.');
  });

  it('falls back to the live view when authority did not answer', () => {
    const s = autonomyOffState({ authority: null, live: { ...dark, stateReason: 'The daemon is not running' } })!;
    expect(s).toMatchObject({ kind: 'dark', title: 'Fleet is dark', why: 'The daemon is not running.', go: { section: 'fleet' } });
  });

  it('calls a quiet fleet quiet — never dark — and only when it is not running', () => {
    const idle = { ...fleetLive('live', NOW), state: 'idle' as const, darkSince: null };
    const s = autonomyOffState({ authority: authorityStatus('live', NOW), live: idle, quietSince: '2026-08-18T12:00:00Z' })!;
    expect(s.kind).toBe('quiet');
    expect(s.since).toBe(`Nothing produced since ${darkSinceLabel('2026-08-18T12:00:00Z')}`);
    expect(s.since).not.toMatch(/dark/);
    expect(autonomyOffState({ authority: authorityStatus('live', NOW), live: fleetLive('live', NOW), quietSince: '2026-08-18T12:00:00Z' })).toBeNull();
  });
});

