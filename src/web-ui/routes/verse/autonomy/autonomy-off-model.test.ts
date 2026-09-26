import { describe, expect, it } from 'vitest';
import { authorityStatus, DARK_SINCE, fleetLive } from '../command/fixtures.test-support.js';
import { darkSinceLabel } from '../fleet/dark-since.js';
import { SETUP_COMMAND, autonomyOffState, draftReadiness, setupChecks } from './autonomy-off-model.js';

const NOW = Date.parse('2026-09-25T15:00:00Z');
const dark = fleetLive('dark', NOW);
const noGrant = authorityStatus('dark', NOW);

describe('autonomyOffState', () => {
  it('is null for an active, producing fleet — and before anything has answered', () => {
    expect(autonomyOffState({ authority: authorityStatus('live', NOW), live: fleetLive('live', NOW) })).toBeNull();
    expect(autonomyOffState({ authority: null, live: null })).toBeNull();
  });

  it('asks for the one-time setup when no grant can be drafted yet', () => {
    const s = autonomyOffState({ authority: noGrant, live: dark, draft: 'setup' })!;
    expect(s.kind).toBe('setup');
    expect(s.title).toBe('Autonomy is off');
    expect(s.why).toBe('Nothing runs or merges on its own until the one-time setup is done.');
    expect(s.command).toBe(SETUP_COMMAND);
    expect(s.grant).toBeNull();
    // THE dark-since instant, as the viewer's local day.
    expect(s.since).toBe(`Fleet dark since ${darkSinceLabel(DARK_SINCE)}`);
  });

  it('asks for a grant when one can be drafted (or the draft said something else)', () => {
    for (const draft of ['ready', 'unknown'] as const) {
      const s = autonomyOffState({ authority: noGrant, live: dark, draft })!;
      expect(s.kind).toBe('grant');
      expect(`${s.title}. ${s.why}`).toBe('Autonomy is off. Approve a standing grant to let the fleet work.');
      expect(s.grant).toEqual({ intent: 'grant', label: 'Approve grant' });
      expect(s.go).toEqual({ section: 'command', anchor: null, label: 'Approve in Command' });
      expect(s.command).toBeNull();
    }
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

describe('setupChecks', () => {
  it('lists the five steps Verse can see, and nothing when custody is unreadable', () => {
    const partial = authorityStatus('dark', NOW, { custody: { installed: true, keyInitialized: true, githubApp: false, claudeToken: null } });
    expect(setupChecks(partial).map((c) => [c.label, c.done])).toEqual([
      ['Custody helper', true],
      ['Signing key', true],
      ['GitHub App', false],
      ['Claude token', null],
      ['Standing grant', false],
    ]);
    expect(setupChecks(noGrant)).toEqual([]);
  });
});

describe('draftReadiness', () => {
  it('reads the grant draft: drafted → ready; no trust root → setup; anything else → unknown', () => {
    expect(draftReadiness(undefined)).toBeUndefined();
    expect(draftReadiness({ value: { digest: 'x' } })).toBe('ready');
    expect(draftReadiness({ value: null, code: 'no-trust-roots' })).toBe('setup');
    expect(draftReadiness({ value: null, code: 'custody-key-unknown' })).toBe('setup');
    expect(draftReadiness({ value: null, code: 'ledger' })).toBe('unknown');
    expect(draftReadiness({ value: null })).toBe('unknown');
  });
});
